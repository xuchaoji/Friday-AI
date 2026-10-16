#!/usr/bin/env node
'use strict'

// FridayAI 外置大脑。
//
// 架构：薄执行器 (mc-agent.js) + 外置大脑 (本文件)。
// 执行器只负责连接、传感、和"一个"有界动作；大脑负责 观察 → 判断 → 短动作 → 验证 → 重规划 的闭环。
// 绝不在执行器里塞自治状态机，也绝不把整栋房子的施工写死成脚本——每一步都由模型决策。
//
// 运行：node friday-brain.js [configPath]
//
// 设计参考：
//  - dsh-minecraft（12 个原子工具，"one game action each, none of them plans"）
//    https://github.com/Ruqii/dsh-minecraft
//  - ODYSSEY: Empowering Agents with Open-World Skills（IJCAI 2025）
//    40 个 primitive skills = 32 operational + 8 spatial；https://arxiv.org/abs/2407.15325
//  - Voyager: An Open-Ended Embodied Agent with Large Language Models（skill library 思路）
// 本大脑只借用它们的**原子操作分类**；规划与编排始终由大模型完成。

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { createRequire } = require('module')

const DEFAULT_CONFIG = process.env.MC_AI_CONFIG || '/root/.config/minecraft-ai/config.json'
const configPath = process.argv[2] || DEFAULT_CONFIG
if (!fs.existsSync(configPath)) {
  console.error(`Missing config: ${configPath}`)
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))

const API_HOST = cfg.apiHost || '127.0.0.1'
const API_PORT = Number(cfg.apiPort || 8765)
const API_TOKEN = cfg.apiToken || ''
const PLAN_PATH = cfg.planPath || '/root/.config/minecraft-ai/plan.json'
const TASK_PATH = cfg.taskPath || '/root/.config/minecraft-ai/task.txt'
const LOCK_PATH = cfg.brainLockPath || '/root/.config/minecraft-ai/brain.lock'
const LOG_PATH = cfg.brainLogPath || '/tmp/friday-brain.log'
const MASTERS = Array.isArray(cfg.masters) ? cfg.masters : ['chaoji34']
const IDLE_INTERVAL_MS = Number(cfg.brainIdleIntervalMs || 12000)
const ACTIVE_INTERVAL_MS = Number(cfg.brainActiveIntervalMs || 4000)
const DANGER_INTERVAL_MS = Number(cfg.brainDangerIntervalMs || 2500)
const MAX_PLAN_STEPS = Number(cfg.brainMaxPlanSteps || 6)      // 一轮最多连续执行几步
const PLAN_BUDGET_MS = Number(cfg.brainPlanBudgetMs || 110000) // 一轮批处理的墙钟预算
const PRIVATE_THOUGHT_MESSAGES = cfg.privateThoughtMessages === true // 用 /msg 私聊给主人发送决策摘要
const THOUGHT_RECIPIENT = String(cfg.thoughtRecipient || MASTERS[0] || 'chaoji34')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
  console.log(line)
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch (_) {}
}

// ---------------- HTTP 到执行器 ----------------
function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      host: API_HOST, port: API_PORT, path: urlPath, method,
      headers: Object.assign(
        { authorization: `Bearer ${API_TOKEN}` },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      ),
      timeout: 120000
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad JSON from executor: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('executor timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

const observe = (opts = {}) => {
  const qs = new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)])).toString()
  return api('GET', '/observe' + (qs ? '?' + qs : ''))
}
const act = action => api('POST', '/act', action)

// ---------------- 计划文件（大脑的持久记忆） ----------------
function defaultPlan() {
  return {
    createdAt: new Date().toISOString(),
    goal: null,
    blueprint: null,
    anchor: null,
    checklist: [],
    tasks: [],
    currentTaskId: null,
    failureMemory: {},
    notes: [],
    history: []
  }
}
function loadPlan() {
  try {
    const p = Object.assign(defaultPlan(), JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')))
    // 只有被校验过的锚点才可信；否则视为未选址（防止模型臆造坐标污染施工）
    if (!p.anchorValid) p.anchor = null
    return p
  } catch (_) { return defaultPlan() }
}
function savePlan(plan) {
  try {
    plan.updatedAt = new Date().toISOString()
    if (plan.history.length > 40) plan.history = plan.history.slice(-40)
    if (plan.notes.length > 20) plan.notes = plan.notes.slice(-20)
    fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2))
  } catch (e) { log('savePlan failed:', e.message) }
}

// ---------------- LLM ----------------
function readCredential(name) {
  try {
    const t = fs.readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
    const m = t.match(new RegExp(name + ':\\s*([^\\s]+)'))
    return m ? m[1] : null
  } catch (_) { return null }
}

// chengqi 提供方的模型，**按能力从强到弱排序**，依次降级尝试。
// 注意：这里不再包含任何 DeepSeek —— 用户明确要求只用 chengqi 的模型。
// 排序依据：推理/工具调用/长程规划能力。图像类(gpt-image-*)与审查类(codex-auto-review)已排除。
const CHENGQI_MODEL_CHAIN = [
  // —— 第一梯队：强推理 / 长程规划 ——
  'claude-opus-4-6-thinking',
  'gpt-5.6-sol',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-luna',
  // —— 第二梯队：通用强模型 ——
  'gpt-5.5',
  'claude-sonnet-4-6',
  'gemini-pro-agent',
  'gemini-3.8-flash-high',
  'gemini-3.7-flash-high',
  // —— 第三梯队：快速模型（保底可用）——
  'gemini-3.6-flash-high',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
  'gpt-oss-120b-medium',
  'gemini-3.1-flash-lite'
]

function llmTargets() {
  const key = process.env.CHENGQI_API_KEY || cfg.llmApiKey || readCredential('CHENGQI_API_KEY')
  if (!key) return []
  const baseURL = cfg.llmBaseURL || 'https://1.aczaf.top/v1'
  // 允许用配置覆盖链（cfg.llmModelChain 为数组），否则用上面的默认能力序
  const chain = Array.isArray(cfg.llmModelChain) && cfg.llmModelChain.length ? cfg.llmModelChain : CHENGQI_MODEL_CHAIN
  return chain.map(model => ({ model, apiKey: key, baseURL }))
}

function httpJSON(target, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${target.baseURL}/chat/completions`)
    const payload = JSON.stringify(body)
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${target.apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${String(data).slice(0, 160)}`))
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad JSON from LLM')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')) })
    req.write(payload)
    req.end()
  })
}

// 模型冷却表：429/503/TLS 等"暂时不可用"后短时间内不再尝试它。
// 不加这个的话，每轮都会先撞已挂掉的主模型（实测撞了 2854 次），
// 每轮白费十几秒，让本就不快的循环雪上加霜。
const modelCooldownUntil = {}
const MODEL_COOLDOWN_MS = Number(cfg.modelCooldownMs || 300000)   // 5 分钟；模型链很长，避免反复撞同一批
const MODEL_MAX_TRIES_PER_ROUND = Number(cfg.modelMaxTriesPerRound || 4)  // 一轮最多试几个模型，避免 429 风暴拖慢决策

async function llmChat(messages, { temperature = 0.3, timeoutMs = 60000 } = {}) {
  const targets = llmTargets()
  if (!targets.length) throw new Error('未配置任何 LLM API KEY')
  let lastErr = null
  let tried = 0
  for (const target of targets) {
    if (tried >= MODEL_MAX_TRIES_PER_ROUND) {
      log(`[LLM] 本轮已尝试 ${tried} 个模型，其余跳过（避免 429 风暴拖慢决策）`)
      break
    }
    const cd = modelCooldownUntil[target.model] || 0
    if (Date.now() < cd) {
      log(`[LLM] ${target.model} 冷却中（剩 ${Math.ceil((cd - Date.now()) / 1000)}s），跳过`)
      continue
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const json = await httpJSON(target, { model: target.model, messages, temperature }, timeoutMs)
        const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
        if (!content) throw new Error('empty content')
        delete modelCooldownUntil[target.model]
        return { content, model: target.model, fallback: target.model !== targets[0].model }
      } catch (e) {
        lastErr = e
        const msg = String(e.message || '')
        log(`[LLM] ${target.model} attempt ${attempt} failed: ${msg.slice(0, 140)}`)
        if (/429|model_cooldown|503|502|TLS|ECONNRESET|timed out/i.test(msg)) {
          // 429 或限流属于立即冷却，不浪费本轮的有效计算尝试配额
          modelCooldownUntil[target.model] = Date.now() + MODEL_COOLDOWN_MS
          log(`[LLM] ${target.model} 进入 ${Math.round(MODEL_COOLDOWN_MS / 1000)}s 冷却`)
          break
        }
        tried++
        if (attempt < 2) await sleep(1200)
      }
    }
  }
  throw new Error(`所有模型通道失败: ${lastErr && lastErr.message}`)
}

function extractJSON(text) {
  if (!text) return null
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(s) } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch (_) {} }
  return null
}

// ---------------- 提示词：把 skill 的决策纪律写进系统提示 ----------------
const SYSTEM_PROMPT = `你是 FridayAI，一个在 Minecraft 自由沙盒世界里具备高自主决策与敏捷规划能力的 AI 伙伴。
你是"决策大脑"：以目标为导向（Goal-Driven），根据主人的长期任务与实时环境，自主将大目标拆解为阶段性里程碑，动态编排行动流水线并自适应调整策略。
主人是 ${MASTERS.join('、')}。只有主人的指令是最高指令；内部 thought 记录真实决策考量，对外说话简短、真诚、只陈述客观事实。

===== 沙盒动态规划与自主核心准则 =====
1. **沙盒游戏的本质是动态适应，绝不死板僵化**：
   - 面对任何目标（采矿、建造、探索、农业、生存、战斗），不要将环境假设为固定剧本。
   - 资源是流动的：
     * 缺火把 -> 既可地下挖煤，也可伐木在熔炉烧木炭，现场合成火把照明；
     * 缺食物/生命偏低 -> 既可地表 hunt 猎杀动物烤肉，也可收割农田/钓鱼/采集浆果；
     * 缺工具 -> 就地采集基础材料（木头/石头/铁），在工作台合成升级；
     * 箱子不存在或物资耗尽 -> 自主就地取材，绝不把时间和生命浪费在死磕单一不存在的容器上。
   - 绝不因单个路径或资源的缺失而原地卡死。条条大路通罗马，当前方案受阻立即切换备选方案！

2. **自给自足与前置依赖闭环（遇到阻碍自主突破）**：
   - 遇到任何前提条件不足时，**自动将"解决前置条件"作为当前的阶段性任务**：
     * 背包空间不足 -> 主动调用 discard 丢弃大量圆石、深板岩碎石等廉价垃圾方块，为核心产物腾出槽位；
     * 地形阻挡或卡位 -> 善用 jump、digStair、mine、或安全区域短途 flyTo 调整身位，绝不原地打转；
     * 遇到水流/熔岩/悬崖阻隔 -> 使用手头圆石/泥土封堵水源、铺垫搭桥或转向绕道；
     * 遇到苦力怕逼近 -> 避免近战引爆，用后撤(retreat)或远程/垫高拉开距离；生命危急时自保避险优先级高于盲目作业。
   - 满足前置条件后，无缝切换回核心主线目标，绝不当死循环卡死的巨婴。

3. **目标驱动与任务敏捷流转 (Goal & Tasks 流转)**：
   - 维护 2~5 个清晰的动态滚动阶段（例如：准备补给 -> 建立通道 -> 核心采集/作业 -> 物资整备 -> 安全返航）。
   - 每轮结合观察数据，自主推进最迫切的阶段；当阶段目标达成或环境剧变时，**主动重构 tasks 列表**。
   - 严禁死守已经失效的旧任务，随时根据主人最新指令和环境反馈敏捷迭代。
   - 动作真实性：严禁在没有客观数据（如 dug > 0, placed > 0, moved > 1）支持下虚构成果。

4. **物理常识与安全底线**：
   - 采矿常识：不在正头顶直挖（防沙砾塌落/水/岩浆），不在正脚下直挖（防跌落熔岩/深渊）；深层（Y < 50）实心岩石下禁止穿墙飞行（避免反作弊踢出）；
   - 尊重已有成果：严禁随意拆除主人已建好的建筑、大门和功能设施。

===== 可用动作（executor actions）=====
- {"type":"status","args":{}}                     查看自身状态（不掉血、不改世界）
- {"type":"gatherExposed","args":{"names":["iron_ore","deepslate_iron_ore"],"count":2,"radius":32}}  ★ 宏动作：自动寻找目标矿石、寻路走近、开采并拾取掉落物。找矿采矿首选！
- {"type":"craftPickaxe","args":{"material":"iron"}}  ★ 宏动作：自动合成铁镐/石镐（自动识别附近工作台、木棍并合成）
- {"type":"chest","args":{"action":"withdraw","item":"iron_ingot","count":1}}  ★ 箱子交互：打开箱子取物或存物（action: withdraw/deposit）
- {"type":"scan","args":{"radius":32}}            扫描周围原木/石头/矿石/水
- {"type":"inspect","args":{"x1":..,"y1":..,"z1":..,"x2":..,"y2":..,"z2":..,"list":true}}  精确查看某区域方块
- {"type":"door","args":{"x":4,"y":64,"z":87,"state":"open"}}  开关门（state: open/close/toggle）；会读回门属性确认，返回 verified
- {"type":"passDoor","args":{"door":{"x":4,"y":64,"z":87},"via":{"x":5,"y":64,"z":87},"to":{"x":4,"y":64,"z":89}}}  ★ 开门→穿过→随手关门。via = 门洞旁"没门的那一格"，强烈建议传；返回 verdict
- {"type":"verifyAccess","args":{"outside":{"x":4,"y":64,"z":85},"inside":{"x":4,"y":64,"z":89}}}  ★ 实测"房子能不能走进去"，失败时给出真正挡路的方块（区分天然/建材）
- {"type":"protectRegion","args":{"x1":1,"x2":7,"y1":63,"y2":66,"z1":87,"z2":91,"label":"house"}}  把成品登记为受保护区，机器人从此无法拆它（验收 PASS 后系统会自动调用，通常你不用管）
- {"type":"diagnose","args":{"x":4,"y":64,"z":88,"range":1}}  诊断"我为什么到不了那里"：返回可达性、直线挡路方块清单、附近门的位置与 advice。**不要改动世界，纯测量。**
- {"type":"verifyStructure","args":{"x1":1,"x2":7,"z1":87,"z2":91,"floorY":63,"wallFromY":64,"wallToY":65,"roofY":66,"openings":[{"x":3,"y":65,"z":87}],"doors":[{"x":4,"y":64,"z":87}]}}
     ★ 房屋验收的唯一权威动作：按蓝图逐格核对，返回 missingWalls/missingRoof/missingFloor/blockedOpenings/doorProblems 和 verdict(PASS/FAIL)。
- {"type":"move","args":{"x":..,"y":..,"z":..,"range":1,"maxDistance":48}}  走近某点
- {"type":"chop","args":{"count":6,"radius":32}}   砍树
- {"type":"mine","args":{"names":["stone","cobblestone"],"count":12,"radius":24}}  挖指定方块
- {"type":"digStair","args":{"dx":1,"dz":0,"steps":6}}  安全下挖阶梯
- {"type":"branchMine","args":{"dx":1,"dz":0,"length":10,"ores":["coal_ore","iron_ore"]}}  水平挖矿
- {"type":"craftAtomic","args":{"item":"birch_door","count":1}}  ★ 原子合成：附近有工作台就用手上的，缺工作台/缺材料会**如实报缺**，不会偷偷替你放工作台。优先用它。
- {"type":"craftChain","args":{"item":"birch_door","count":1}}      便利版：会自动找/放工作台再合成（会替你做决定，尽量少用）
- {"type":"smelt","args":{"x":2,"y":58,"z":49,"input":"raw_iron","fuel":"stick","count":3,"fuelCount":3}}  指定熔炉坐标熔炼，以输出/背包增量验证成功
- {"type":"furnaceTake","args":{"x":2,"y":58,"z":49}}  取出指定熔炉的残留输入、燃料和输出
- {"type":"sleep","args":{"x":3,"y":64,"z":89}}  在指定坐标的床上睡觉
- {"type":"travel","args":{"x":..,"y":..,"z":..,"hop":12,"maxHops":6}}  分段长距离移动（>20格优先）
- {"type":"jump","args":{"count":1}}        纯跳跃（上台阶、越1格障碍、脱半砖夹缝）
- {"type":"retreat","args":{"distance":6}}  远离最近敌对生物若干格（对苦力怕等，优先逃而不是打）  合成（自动找/放工作台）
- {"type":"collect","args":{"radius":10}}         捡掉落物
- {"type":"placeAt","args":{"item":"birch_door","x":..,"y":..,"z":..}}  在指定位置放置物品
- {"type":"buildLine","args":{"x":..,"y":..,"z":..,"dx":1,"dz":0,"count":8,"item":"cobblestone"}}  沿方向砌一段（≤16）
- {"type":"buildLayer","args":{"x1":..,"y1":..,"z1":..,"x2":..,"y2":..,"z2":..,"item":"cobblestone"}}  铺一层（≤64 块）
- {"type":"clearArea","args":{"x1":..,"y1":..,"z1":..,"x2":..,"y2":..,"z2":..}}  挖掉一小片（≤64，用于找平/拆除）
- {"type":"recover","args":{"allowTeleport":true}}  ★ 物理卡死时的一键恢复：松控制→跳/侧移→开门→（授权时）传送回安全点重新同步。
     什么时候用：连续两次 move/travel 都返回 progress=0，或 stepTest 显示 moved<0.3，而 diagnose 却说路径通畅。
- {"type":"eat","args":{}}  ★ 吃东西。食物低/掉血时吃背包现有食物
- {"type":"hunt","args":{"names":["pig","cow","sheep","chicken"],"count":2,"radius":32}} ★ 狩猎获取生肉/食物。当缺少食物、生命或饱食不足时，主动去地表寻找并狩猎动物！
- {"type":"farm","args":{"positions":[{"x":..,"y":..,"z":..}]}} ★ 农耕/种小麦。有种子和锄头时开垦耕地
- {"type":"fly","args":{"state":"on"}}  开/关飞行（幂等，自动识别 /fly 是切换）
- {"type":"flyTo","args":{"x":16,"y":64,"z":84}}  立体飞到目标点，专治"卡在洞里/爬不上去"
- {"type":"land","args":{}}  悬空时落回地面
- {"type":"escape","args":{}} 被埋在方块里时的破壳脱身
- {"type":"guard","args":{"radius":8,"count":3}}   清掉附近怪
- {"type":"placeTorch","args":{}}                  脚下插火把
- {"type":"command","args":{"command":"/home survival"}}  传回基地（采矿完成或夜晚避难时使用）
  ⚠ 严禁频繁在 /spawn 和 /home survival 之间来回传送（禁止把传送当成卡位脱困手段！卡位时请用 recover、jump、挖掉阻挡方块或 travel）。
  ⚠ 禁止用 /spreadplayers 或把自己 /tp 到未知位置——那会把你丢到几千格外。
    回不了家时用 /home survival；command 动作已对这类高危位移做了硬拦截。
- {"type":"stop","args":{}}                        紧急停下
- null                                            仅当纯寒暄、无事可做时

===== 输出格式（严格 JSON，不要多余文字）=====
{
  "thought": "中文决策摘要：当前任务 → 前置条件/缺口 → 下一步（不要输出完整推理链）",
  "chatReply": "要对主人说的话，25 字内；无话可说填 null",
  "planUpdate": {
     "goal": "当前主目标，没有则 null",
     "blueprint": "可选的简短方案描述",
     "anchor": {"x":0,"y":64,"z":0},
     "currentTaskId": "task-id",
     "tasks": [{"id":"task-1","title":"明确子任务","status":"pending|ready|blocked","dependsOn":[],"successCriteria":"客观完成判据","nextStrategy":"失败时换什么策略"}],
     "structure": {"label":"house","x1":..,"x2":..,"z1":..,"z2":..,"floorY":..,"wallFromY":..,"wallToY":..,"roofY":..,"openings":[...],"doors":[...],"outside":{...},"inside":{...}} 或 null
  },
  "pipeline": [
     {"type":"...", "args":{...}},
     {"type":"...", "args":{...}}
  ],
  "action": null
}

【关于 pipeline（最高效模式，强烈推荐优先使用）】
一次大模型往返需 5~15 秒，频繁单步微操会极大拖慢整体任务并导致超时。
请尽量一次给出包含完整小闭环的 pipeline 动作序列（2~6个动作）。
本地 Actor 执行器会在本地连续执行完所有步骤，每步带有严格的前置/后置断言校验；
只有当全部完成、或某一步断言失败时才会唤醒你。
例·采铁并回家合成铁镐:
"pipeline": [
  {"type":"gatherExposed","args":{"names":["iron_ore","deepslate_iron_ore"],"count":3,"radius":24}},
  {"type":"travel","args":{"x":4,"y":64,"z":89,"hop":12,"maxHops":6}},
  {"type":"smelt","args":{"input":"raw_iron","fuel":"oak_planks","count":3}},
  {"type":"craftPickaxe","args":{"material":"iron"}}
]
规则：每步短小有界、彼此衔接；任何一步失败系统会自动停止并生成 Reflexion 反思报告交还你重规划。
}`

function computeDiff(obs, plan) {
  const s = obs.self || {}
  const curPos = s.position ? [Math.round(s.position.x), Math.round(s.position.y), Math.round(s.position.z)] : null
  const curInv = {}
  for (const item of (obs.inventory || [])) {
    curInv[item.name] = (curInv[item.name] || 0) + item.count
  }

  const last = plan.lastStateSnapshot || null
  let diffStr = ''
  if (last && last.pos && curPos) {
    const dx = curPos[0] - last.pos[0]
    const dy = curPos[1] - last.pos[1]
    const dz = curPos[2] - last.pos[2]
    const invDiff = []
    const allKeys = new Set([...Object.keys(curInv), ...Object.keys(last.inv || {})])
    for (const k of allKeys) {
      const c = curInv[k] || 0
      const p = (last.inv || {})[k] || 0
      if (c !== p) {
        invDiff.push(`${k}: ${c > p ? '+' : ''}${c - p} (现存 ${c})`)
      }
    }
    diffStr = `【增量变化 (State Diffing)】\n- 位移: dx=${dx}, dy=${dy}, dz=${dz} (当前位置: [${curPos.join(',')}])\n- 背包变化: ${invDiff.length ? invDiff.join(', ') : '无变化'}`
  } else {
    diffStr = `【初始状态】当前位置: [${curPos ? curPos.join(',') : '?'}]`
  }

  plan.lastStateSnapshot = { pos: curPos, inv: curInv, at: new Date().toISOString() }
  return diffStr
}

function buildUserPrompt(obs, plan, pending, lastResult) {
  const s = obs.self || {}
  const inv = (obs.inventory || []).map(i => `${i.name}x${i.count}`).join(', ') || '(空)'
  const entities = (obs.entities || []).filter(e => e.distance <= 20)
  const activeThreats = entities.filter(e => e.hostile && e.lineOfSight !== false)
  const blockedHostiles = entities.filter(e => e.hostile && e.lineOfSight === false)
  const nonHostile = entities.filter(e => !e.hostile)

  // 语义降维：剔除常规无交互方块（空气、普通石头、泥土等），只提取功能/高价值 POI 方块
  const poiSummary = {}
  const mundaneBlocks = new Set(['air', 'cave_air', 'stone', 'dirt', 'grass_block', 'deepslate', 'diorite', 'andesite', 'granite', 'bedrock'])
  for (const b of (obs.blocks || [])) {
    if (!mundaneBlocks.has(b.name)) poiSummary[b.name] = (poiSummary[b.name] || 0) + 1
  }

  const diffStr = computeDiff(obs, plan)
  const compactPlan = {
    goal: plan.goal || null,
    currentTaskId: plan.currentTaskId || null,
    tasks: (plan.tasks || []).map(t => ({ id: t.id, title: t.title, status: t.status, successCriteria: t.successCriteria })),
    anchor: plan.anchor || null
  }

  const reflexionBlock = plan.lastReflexion ? `
===== 核心反思与断言失败现场 (Reflexion) =====
${plan.lastReflexion}
⚠ 请注意：上一轮执行触发了上述具体断言异常！你必须在此次决策中针对该失败根因重新调整规划，绝不允许使用相同错误参数！\n
` : ''

  const lastChest = (obs.memory && obs.memory.lastChest) || null
  const chestStr = lastChest ? `已知箱子库存 (坐标: ${lastChest.pos ? JSON.stringify(lastChest.pos) : '附近'}): ${lastChest.summary || '(空)'}` : ''
  const absentItems = (plan.absentChestItems && plan.absentChestItems.length) ? `【箱子黑名单 (实测绝对不存在，严禁尝试取出)】: ${plan.absentChestItems.join(', ')}` : ''

  return `${reflexionBlock}===== 当前语义观察 =====
你在: (${s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '?'})  维度: ${s.dimension || '?'}
生命: ${s.health}/20   饱食: ${s.food}/20   手持: ${s.heldItem ? s.heldItem.name : '空手'}
时间: ${s.time ? (s.time.isDay ? '白天' : '夜晚') + `(timeOfDay=${s.time.timeOfDay})` : '?'}
背包概览: ${inv}
${chestStr ? chestStr + '\n' : ''}${absentItems ? absentItems + '\n' : ''}
${diffStr}

附近直接威胁(无遮挡视线内): ${activeThreats.length ? activeThreats.map(e => `${e.name}@${e.distance}`).join(', ') : '无'}
隔墙/门外游荡怪物(被阻隔无直接危险): ${blockedHostiles.length ? blockedHostiles.map(e => `${e.name}@${e.distance}`).join(', ') : '无'}
其他生物: ${nonHostile.length ? nonHostile.map(e => `${e.name}@${e.distance}`).join(', ') : '无'}
附近可交互/资源方块 (POI): ${Object.entries(poiSummary).map(([k, v]) => `${k}x${v}`).join(', ') || '无特殊方块'}
${plan.structure ? `
===== 你的家 (蓝图) =====
范围: x ${plan.structure.x1}..${plan.structure.x2}, z ${plan.structure.z1}..${plan.structure.z2}, 地板 y=${plan.structure.floorY}, 屋顶 y=${plan.structure.roofY}
` : ''}
===== 目标与规划进度 (精简) =====
${JSON.stringify(compactPlan, null, 2)}

===== 上轮真实执行结果 =====
${lastResult ? JSON.stringify(lastResult).slice(0, 800) : '(首轮执行)'}

===== 主人指令 =====
${pending.length ? pending.map(p => `${p.from}: ${p.text}`).join('\n') : '(无新指令)'}

请以 Manager 身份输出决策。优先推荐使用复合 pipeline 批处理。严格返回 JSON。`
}

// 控制通道：外部（人或脚本）把指令写进 task.txt，大脑每轮读取并消费后删除该文件。
// 这样既能被游戏内聊天驱动，也能被命令行驱动。
function drainTaskFile() {
  try {
    if (!fs.existsSync(TASK_PATH)) return []
    const txt = fs.readFileSync(TASK_PATH, 'utf8').trim()
    fs.unlinkSync(TASK_PATH)
    if (!txt) return []
    return txt.split('\n').map(l => l.trim()).filter(Boolean)
      .map((t, i) => ({ id: 'f' + Date.now() + i, from: MASTERS[0], text: t, at: new Date().toISOString(), viaFile: true }))
  } catch (_) { return [] }
}

// ---------------- 主循环 ----------------
let lastResult = null

const ALLOWED_ACTIONS = new Set([
  'status','scan','inspect','stop','chat','ackChat','command','move','travel','follow','steer','look',
  'attack','guard','mineAt','mine','digStair','branchMine','chop','collect','collectDrops','harvestGrass',
  'hunt','farm','sleep','eat','equip','discard','craft','craftAtomic','craftChain','furnaceTake','smelt',
  'place','placeAt','placeDoor','placeTorch','plantSaplings','buildLine','buildLayer','clearArea','door',
  'passDoor','diagnose','probeBlock','stepTest','protectRegion','unprotectRegion','verifyAccess',
  'verifyStructure','fly','flyTo','land','escape','recover','jump','retreat','pillarUp','unstuck','setHome',
  'gatherExposed','craftPickaxe','chest','pipeline'
])

function cleanAction(action) {
  if (!action || typeof action !== 'object' || !ALLOWED_ACTIONS.has(action.type)) return null
  return { type: action.type, args: action.args && typeof action.args === 'object' ? action.args : {} }
}

function actionKey(action) {
  const a = cleanAction(action)
  if (!a) return 'invalid'
  const subList = Array.isArray(a.args && a.args.steps) ? a.args.steps : (Array.isArray(a.args && a.args.actions) ? a.args.actions : null)
  if (a.type === 'pipeline' && subList) {
    const subKeys = subList.map(actionKey).join(';')
    return `pipeline:[${subKeys}]`
  }
  const target = Object.fromEntries(Object.entries(a.args).filter(([k]) =>
    ['x','y','z','x1','y1','z1','x2','y2','z2','name','names','item','command','dx','dz'].includes(k)))
  return `${a.type}:${JSON.stringify(target)}`
}

function errorClass(error) {
  const s = String(error || '').toLowerCase()
  if (/timeout|超时/.test(s)) return 'timeout'
  if (/unreachable|不可达|path|goal/.test(s)) return 'unreachable'
  if (/missing|缺少|not found/.test(s)) return 'missing-resource'
  if (/occupied|占据|blocked|挡路/.test(s)) return 'blocked'
  return s.slice(0, 80) || 'unknown'
}

function pickInterval(obs) {
  const s = obs.self || {}
  const hostiles = (obs.entities || []).filter(e => e.hostile && e.distance <= 12)
  if (hostiles.length || (s.health != null && s.health <= 10)) return DANGER_INTERVAL_MS
  const plan = loadPlan()
  if (plan.goal) return ACTIVE_INTERVAL_MS
  return IDLE_INTERVAL_MS
}

// ================= 强制保障层（不依赖模型自觉） =================
// 设计原则：提示词只是"建议"，只有代码闸门才是"保证"。
// 这里做四件事：① 每轮自动复核结构 ② 检出回归立刻强制修复
//              ③ 未通过验收就不许宣布完成 ④ 长时间无进展就升级求助

function structureArgs(st) {
  return {
    x1: st.x1, x2: st.x2, z1: st.z1, z2: st.z2,
    floorY: st.floorY, wallFromY: st.wallFromY, wallToY: st.wallToY, roofY: st.roofY,
    openings: st.openings || [], doors: st.doors || []
  }
}

function deficiencyList(v) {
  const out = []
  for (const b of (v.missingWalls || [])) out.push({ kind: 'wall', x: b.x, y: b.y, z: b.z })
  for (const b of (v.missingRoof || [])) out.push({ kind: 'roof', x: b.x, y: b.y, z: b.z })
  for (const b of (v.missingFloor || [])) out.push({ kind: 'floor', x: b.x, y: b.y, z: b.z })
  return out
}

// 自动复核：无论模型想不想验，每轮都验一次
const VERIFY_MAX_DISTANCE = 64   // 超过这个距离，建筑所在区块根本没加载，测量无意义

function isBuildingGoal(plan) {
  const g = String(plan && plan.goal || '') + ' ' + String(plan && plan.blueprint || '')
  return /盖房|建房|建造|建一栋|房子|庇护所|house|shelter|扩建|改造|维护|窗洞|墙体|修房/i.test(g)
}

async function autoVerify(plan, obs, { force = false } = {}) {
  // 目标动态化：只有当前大目标涉及建筑/房屋时，才进行自动复核结构
  // 如果当前大目标是挖矿、采集、战斗或生存发展，绝不强制卡在建筑验收上
  if (!isBuildingGoal(plan)) return null
  const st = plan.structure
  if (!st || !Number.isFinite(st.x1)) return null
  // **距离守卫**：离建筑太远时 bot.blockAt 读不到方块，会把整栋房子算成"缺失"，
  // 进而触发无意义的强制抢修 —— 这正是"唐僧式死循环"的根源（实测 8900 格外报了 104 个假缺口，
  // 模型的 97 次 /home 全被闸门丢弃）。
  const bp = obs && obs.self && obs.self.position
  if (bp) {
    const cx = (st.x1 + st.x2) / 2, cz = (st.z1 + st.z2) / 2
    const dist = Math.hypot(bp.x - cx, bp.z - cz)
    if (dist > VERIFY_MAX_DISTANCE) {
      return { outOfRange: true, distance: Math.round(dist),
               note: `离建筑约 ${Math.round(dist)} 格（>${VERIFY_MAX_DISTANCE}），区块未加载，跳过结构验收` }
    }
  }
  if (!force && plan.lastVerifyAt) {
    const age = Date.now() - new Date(plan.lastVerifyAt).getTime()
    if (age < 12000) return plan.lastVerify || null
  }
  try {
    const res = await act({ type: 'verifyStructure', args: structureArgs(st) })
    const v = res.result || null
    if (v) {
      plan.lastVerify = v
      plan.lastVerifyAt = new Date().toISOString()
      const wasOk = plan.lastVerifyPass === true
      const isOk = !!(v.verdict && String(v.verdict).startsWith('PASS'))
      if (wasOk && !isOk) {
        plan.regression = { at: new Date().toISOString(), detail: v.counts }
        log('[GATE] 检测到结构回归！曾经的 PASS 现在是 FAIL:', JSON.stringify(v.counts))
      }
      plan.lastVerifyPass = isOk
      savePlan(plan)
    }
    return v
  } catch (e) {
    log('[GATE] autoVerify 失败:', e.message)
    return null
  }
}

// 把缺口转成一条明确的抢修指令，绕过模型直接下达（模型可以再决定怎么做，但不能假装不存在）
function repairDirective(v, plan) {
  const defs = deficiencyList(v)
  if (!defs.length && !(v.doorProblems || []).length && !(v.blockedOpenings || []).length) return null
  const lines = ['【系统自动验收发现缺口，必须先补齐，再谈其他】']
  if (defs.length) {
    lines.push('缺失方块（用 buildLine/buildLayer/placeAt 逐格补上）:')
    for (const d of defs.slice(0, 40)) lines.push(`  - ${d.kind} (${d.x},${d.y},${d.z})`)
  }
  for (const d of (v.doorProblems || [])) lines.push(`  - 门未装好 (${d.x},${d.y},${d.z}) 当前是 ${d.found}，请用 placeAt 装门`)
  for (const d of (v.blockedOpenings || [])) lines.push(`  - 窗洞被堵 (${d.x},${d.y},${d.z}) 被 ${d.blockedBy} 占住`)
  lines.push(`复核命令参数（补完后系统会自动再验）: ${JSON.stringify(structureArgs(plan.structure))}`)
  return lines.join('\n')
}

async function round() {
  const obs = await observe({ entityRadius: 24, blockRadius: 5, blockLimit: 60 })
  if (!obs.ok || !obs.ready) {
    log('[wait] executor not ready yet')
    return { interval: 8000 }
  }

  // 消费主人指令
  const queue = (obs.memory && obs.memory.chatQueue) || []
  const fileTasks = drainTaskFile()
  const pending = [...queue.filter(e => MASTERS.includes(e.from) && !e.acked), ...fileTasks]
  if (pending.length) {
    log(`[chat] ${pending.map(p => `${p.from}: ${p.text}`).join(' | ')}`)
  }

  const plan = loadPlan()
  const self0 = obs.self || {}
  const hostiles0 = (obs.entities || []).filter(e => e.hostile && e.distance <= 12)
  const inDanger = hostiles0.length > 0 || (self0.health != null && self0.health <= 12)

  // ---- 强制保障 1（必须最先执行）：无论模型想不想验、清单是否自称完成，系统每轮都自动复核结构 ----
  // 顺序至关重要：一旦把待机判断放在前面，"清单全完成 + 实际有缺口"就会被静默跳过。
  const verify = await autoVerify(plan, obs)
  let forcedDirective = null
  let forcedDefs = []
  if (verify && verify.outOfRange) {
    // 不在范围内：不做任何验收、也不强制抢修，把控制权完全交回模型（它需要先赶路/回家）
    log(`[GATE] ${verify.note} —— 暂停验收与强制抢修，交由模型先赶回建筑`)
    plan.forcedRepairFails = 0
  } else if (verify) {
    const isPass = String(verify.verdict || '').startsWith('PASS')
    if (!isPass) {
      // **抢修熔断**：连续多次强制抢修都失败，说明问题不在"缺几块方块"，
      // 而在更上游（人不在现场 / 够不到 / 蓝图不对）。此时必须停止抢修、把控制权还给模型，
      // 否则就是无限循环（实测：31 次强制抢修、20 次失败、模型 97 次想回家全被丢弃）。
      const cooling = plan.forceRepairCooldownUntil && Date.now() < plan.forceRepairCooldownUntil
      if (cooling) {
        const left = Math.ceil((plan.forceRepairCooldownUntil - Date.now()) / 1000)
        log(`[GATE] 抢修冷却中（还剩 ${left}s），本轮不强制抢修，交由模型自行决策`)
      } else {
        forcedDefs = deficiencyList(verify)
        forcedDirective = repairDirective(verify, plan)
        log('[GATE] 自动验收未通过:', JSON.stringify(verify.counts), '缺口数', forcedDefs.length)
      }
    } else if (plan.structure) {
      // 不信任本地标记：直接问执行器"这个保护区还在不在"。执行器重启会清空内存，
      // 靠 plan.regionProtected 会误判为已保护，导致机器人又能拆房子。
      const live = ((obs.memory && obs.memory.protectedRegions) || [])
      const label = plan.structure.label || 'house'
      if (!live.some(r => r && r.label === label)) {
      // 验收通过 → 立即登记为受保护区，此后任何破坏动作都会被执行器硬性拒绝
        const st = plan.structure
        await act({ type: 'protectRegion', args: {
          x1: st.x1, x2: st.x2, y1: Math.min(st.floorY, st.wallFromY), y2: st.roofY, z1: st.z1, z2: st.z2,
          label, replace: true } }).catch(() => {})
        plan.regionProtected = true
        plan.forcedRepairFails = 0
        plan.forceRepairCooldownUntil = 0
        savePlan(plan)
        log('[GATE] 结构已通过验收，已登记受保护区，机器人无法再拆自己的房子')
      }
    }
  }

  const verifyPass = verify ? String(verify.verdict || '').startsWith('PASS') : null
  const checklistDone = Array.isArray(plan.checklist) && plan.checklist.length > 0 && plan.checklist.every(c => c && c.done)

  // 安全待机：只有在"没有新指令 + 无威胁 + 清单完成 + 结构实测合格"时才允许省掉模型往返。
  // 结构不合格时绝不允许待机——否则机器人会揣着一个破房子假装没事。
  const tasksDone = Array.isArray(plan.tasks) && plan.tasks.length > 0 && plan.tasks.every(t => t && t.status === 'verified')
  const idle = pending.length === 0 && !inDanger && (!plan.goal || tasksDone || (plan.tasks.length === 0 && checklistDone))
    && verifyPass !== false && forcedDefs.length === 0
  if (idle) {
    const q = (obs.memory && obs.memory.chatQueue) || []
    if (q.length) await act({ type: 'ackChat', args: { ids: q.map(e => e.id) } }).catch(() => {})
    log('[idle] 无任务、无威胁、结构实测合格，安全待机中（不调用模型）')
    return { interval: IDLE_INTERVAL_MS }
  }
  if (forcedDefs.length) log('[GATE] 存在结构缺口，禁止待机，进入强制抢修')

  // ---- 强制保障 2：长时间无进展时，自主触发高级反思与物理脱困，绝不打扰主人 ----
  const sig = JSON.stringify({
    v: verify ? verify.counts : null,
    anchor: plan.anchor,
    inv: (obs.inventory || []).length,
    pos: obs.self && obs.self.position ? [Math.round(obs.self.position.x), Math.round(obs.self.position.y), Math.round(obs.self.position.z)] : null
  })
  if (sig === plan.lastSig) plan.sameSigRounds = (plan.sameSigRounds || 0) + 1
  else { plan.sameSigRounds = 0; plan.lastSig = sig }
  if (plan.sameSigRounds >= 5 && plan.goal) {
    log('[GATE] 检测到连续 5 轮无进展，自主执行反思与物理脱困重置')
    plan.notes.push({ at: new Date().toISOString(), thought: `STUCK_AUTO_RECOVER: 连续 ${plan.sameSigRounds} 轮状态停滞，重置失败记忆并扩大环境感知` })
    // 清除可能产生局部极值的旧失败记忆，给大模型重新尝试新路径的空间
    plan.failureMemory = {}
    plan.sameSigRounds = 0
    savePlan(plan)
    // 强制执行脱困恢复与扫描，获取全新环境信息
    await act({ type: 'recover', args: { allowTeleport: false } }).catch(() => {})
    await act({ type: 'scan', args: { radius: 32 } }).catch(() => {})
    forcedDirective = '【自主脱困警报】系统检测到你已连续多轮无实质进展，已为你自动重置历史动作失败锁并扫描周围32格。作为自主AI，你严禁向主人抱怨或求助，必须彻底摒弃刚才无效的微操方式！请重新审视当前大目标，换用更高阶的宏动作（如 travel、gatherExposed、craftPickaxe、flyTo、mineAt 等）或调整子任务拆分策略来打破僵局！'
  }

  // 规划协议与动态任务调度
  // 当收到新指令或当前任务已全部 verified 或处于采矿/生存等动态阶段时，支持根据环境与目标自主流转
  const isMining = /矿|钻石|铁|煤|采掘|mine|diamond|iron|coal|ore/i.test(String(plan.goal || ''))
  const prompt = buildUserPrompt(obs, plan, pending, lastResult) + (forcedDirective ? '\n\n' + forcedDirective : '')

  let llmReply
  try {
    llmReply = await llmChat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ], { temperature: 0.25 })
  } catch (e) {
    log('[LLM] all channels failed:', e.message)
    return { interval: 15000 }
  }

  const decision = extractJSON(llmReply.content)
  if (!decision) {
    log('[LLM] unparseable:', String(llmReply.content).slice(0, 300))
    return { interval: 10000 }
  }

  log(`[brain via ${llmReply.model}] thought:`, String(decision.thought || '').slice(0, 200))
  if (llmReply.fallback && !plan.warnedFallback) {
    plan.warnedFallback = true; savePlan(plan)
    await act({ type: 'chat', args: { message: `[FridayAI] 主模型不可用，暂用 ${llmReply.model} 顶替。` } }).catch(() => {})
  }
  if (!llmReply.fallback) plan.warnedFallback = false
  if (decision.chatReply) log('  reply:', decision.chatReply)
  if (decision.action) log('  action:', JSON.stringify(decision.action))

  // 1) 更新持久计划
  if (decision.planUpdate && typeof decision.planUpdate === 'object') {
    const u = decision.planUpdate
    const oldGoal = plan.goal
    if (u.goal !== undefined) plan.goal = u.goal
    if (u.blueprint !== undefined) plan.blueprint = u.blueprint
    if (u.anchor !== undefined && u.anchor && typeof u.anchor.x === 'number') {
      // 当目标改变、显式请求重置锚点、或锚点未初始化时，允许更新锚点
      const isRelocate = !plan.anchorValid || !plan.anchor || u.relocateAnchor || (u.goal !== undefined && u.goal !== oldGoal)
      if (!isRelocate) {
        log('[plan] 忽略未授权的 anchor 漂移:', JSON.stringify(u.anchor))
      } else {
        const botPos = (obs.self && obs.self.position) || null
        const a = u.anchor
        const sane = [a.x, a.y, a.z].every(v => Number.isFinite(v)) && a.y > -80 && a.y < 400
          && Math.abs(a.x) < 30000000 && Math.abs(a.z) < 30000000
        const near = botPos ? (Math.abs(a.x - botPos.x) <= 160 && Math.abs(a.z - botPos.z) <= 160) : true
        const nearStored = plan.anchor ? (Math.abs(a.x - plan.anchor.x) <= 160 && Math.abs(a.z - plan.anchor.z) <= 160) : true
        if (sane && (near || nearStored)) {
          plan.anchor = { x: Math.round(a.x), y: Math.round(a.y), z: Math.round(a.z) }
          plan.anchorValid = true
          log('[plan] 锚点已成功更新为:', JSON.stringify(plan.anchor))
        } else {
          log(`[plan] 拒绝可疑 anchor ${JSON.stringify(a)}（坐标不合理或超出允许范围）`)
        }
      }
    }
    if (Array.isArray(u.tasks)) {
      plan.tasks = u.tasks.slice(0, 12).map((t, i) => ({
        id: String(t.id || `task-${i + 1}`).slice(0, 40),
        title: String(t.title || t.item || '未命名任务').slice(0, 100),
        status: ['pending', 'ready', 'running', 'blocked', 'verified'].includes(t.status) ? t.status : 'pending',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String).slice(0, 8) : [],
        successCriteria: String(t.successCriteria || '').slice(0, 180),
        nextStrategy: String(t.nextStrategy || '').slice(0, 180)
      }))
    }
    if (u.currentTaskId !== undefined) plan.currentTaskId = u.currentTaskId ? String(u.currentTaskId).slice(0, 40) : null
    // 兼容旧 checklist，但模型声称 done 不能直接成为 verified；只作为展示信息。
    if (Array.isArray(u.checklist)) plan.checklist = u.checklist.map(c => ({ item: c.item, done: false, claimedDone: !!c.done }))
    if (u.structure !== undefined) {
      if (u.structure === null) {
        plan.structure = null
        plan.lastVerifyPass = null
        plan.regionProtected = false
      } else if (typeof u.structure === 'object' && Number.isFinite(Number(u.structure.x1))) {
        const st = u.structure
        // 过滤掉旧房屋假蓝图（如果当前大目标是西南32x32院子，不要再恢复 1..7, 87..91 的旧房子！）
        const isOldHouse = st.x1 === 1 && st.x2 === 7 && st.z1 === 87 && st.z2 === 91
        const isCompoundGoal = /院子|围墙|32|基地|compound|yard/i.test(String(plan.goal || ''))
        if (!(isOldHouse && isCompoundGoal)) {
          plan.structure = {
            label: st.label || 'house',
            x1: Number(st.x1), x2: Number(st.x2), z1: Number(st.z1), z2: Number(st.z2),
            floorY: Number(st.floorY), wallFromY: Number(st.wallFromY), wallToY: Number(st.wallToY), roofY: Number(st.roofY),
            openings: Array.isArray(st.openings) ? st.openings : [],
            doors: Array.isArray(st.doors) ? st.doors : [],
            outside: st.outside || null, inside: st.inside || null
          }
          if (JSON.stringify(plan.structure) !== JSON.stringify(plan._prevStructure)) {
            plan.lastVerifyPass = null; plan.regionProtected = false; plan.lastVerifyAt = null
            plan._prevStructure = plan.structure
            log('[plan] 登记结构蓝图:', JSON.stringify(plan.structure).slice(0, 200))
          }
        }
      }
    }
    if (decision.thought) plan.notes.push({ at: new Date().toISOString(), thought: String(decision.thought).slice(0, 240) })
    savePlan(plan)
  }

  // ---- 强制保障 3：验收未通过、或压根没有可验收蓝图时，禁止宣称"完成" ----
  const claimsDone = /完成|好了|盖好|搞定|达标|建好|done|finished|complete/i.test(String(decision.chatReply || ''))
  const buildGoal = /盖房|建房|建造|建一栋|房子|庇护所|house|shelter|扩建|改造|维护/i.test(String(plan.goal || '') + ' ' + String(plan.blueprint || ''))
  let reply = decision.chatReply
  if (verifyPass === false && reply && claimsDone) {
    log('[GATE] 拦截虚假完成宣告（结构未达标）:', reply)
    reply = '[FridayAI] 还没达标，我正在补缺口。'
  } else if (claimsDone && buildGoal && !plan.structure) {
    // 建筑类目标却没有登记蓝图 => 无人能验收 => "完成"二字一律不认，避免自我认证
    log('[GATE] 拦截无蓝图完成宣告：必须先登记 planUpdate.structure')
    reply = '[FridayAI] 还没有可验收的蓝图，我先登记结构边界再报完工。'
    forcedDirective = (forcedDirective || '') + '\n\n【系统拦截】你声称完工但没有登记 planUpdate.structure，验收无法执行。请立刻补上 structure（房屋真实边界+openings+doors+outside/inside），否则不许再报"完成"。'
  }

  // 2) 说话（思考链 + 回复）
  if (PRIVATE_THOUGHT_MESSAGES && decision.thought) {
    const thought = String(decision.thought).replace(/[\r\n]+/g, ' ').slice(0, 180)
    await act({ type: 'command', args: { command: `/msg ${THOUGHT_RECIPIENT} [AI思考] ${thought}`, waitMs: 250 } }).catch(e => log('[thought msg failed]', e.message))
    await sleep(250)
  }
  if (reply) {
    const text = String(reply).replace(/[\r\n]+/g, ' ').slice(0, 160)
    await act({ type: 'chat', args: { message: `[FridayAI] ${text}`.slice(0, 120) } }).catch(() => {})
    if (pending.some(e => !e.viaFile)) {
      await act({ type: 'command', args: { command: `/msg ${THOUGHT_RECIPIENT} ${text}`, waitMs: 250 } }).catch(() => {})
    }
    await sleep(300)
  }

  // 3) 确认已消费的聊天：只确认本轮真正交给模型处理的主人消息，避免误清其他队列项。
  const handledChatIds = pending.filter(e => !e.viaFile && e.id).map(e => e.id)
  if (handledChatIds.length) {
    await act({ type: 'ackChat', args: { ids: handledChatIds } }).catch(() => {})
  }

  // 4) 执行动作序列
  //
  // 【为什么要支持多步】一次模型往返约 17-40 秒。如果每轮只做一个微动作
  // （走 5 格、挖 1 块），那么"走 60 格回家"就要十几轮、耗时好几分钟，
  // 看起来比脚本还笨。正确做法：让模型一次给出**一小段计划**（几个有界动作），
  // 大脑在一轮里把它们连续执行完，然后重新观察、重新规划。
  // 决策权仍然完全在模型手里——我们只是不再为每个微步骤付一次往返。
  let interval = ACTIVE_INTERVAL_MS
  let actions = []
  if (forcedDefs.length) {
    const d = forcedDefs[0]
    log(`[GATE] 强制执行抢修：补 ${d.kind} (${d.x},${d.y},${d.z})`)
    actions = [{ type: 'placeAt', args: { x: d.x, y: d.y, z: d.z }, __forcedRepair: true }]
  } else if (Array.isArray(decision.pipeline) && decision.pipeline.length) {
    actions = [{ type: 'pipeline', args: { steps: decision.pipeline }, __planMeta: { batchSafe: true } }]
  } else if (Array.isArray(decision.steps) && decision.steps.length) {
    actions = decision.steps
      .filter(s => s && s.action && s.action.type)
      .slice(0, MAX_PLAN_STEPS)
      .map(s => Object.assign({}, s.action, { __planMeta: {
        reason: String(s.reason || '').slice(0, 160),
        successCriteria: String(s.successCriteria || '').slice(0, 180),
        abortConditions: Array.isArray(s.abortConditions) ? s.abortConditions.slice(0, 6) : [],
        strategyTag: String(s.strategyTag || '').slice(0, 60),
        batchSafe: s.batchSafe === true
      } }))
  } else if (Array.isArray(decision.actions) && decision.actions.length) {
    actions = decision.actions.filter(a => a && a.type).slice(0, MAX_PLAN_STEPS)
  } else if (decision.action && decision.action.type) {
    actions = [decision.action]           // 兼容单动作写法
  }

  if (!actions.length) {
    lastResult = { action: null, ok: true, note: '本轮无动作' }
    return { interval }
  }

  const batch = []
  const t0 = Date.now()
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    // 主人中途发话 → 立即停止整批，优先回应
    if (i > 0) {
      try {
        const o2 = await observe({ entityRadius: 1, blockRadius: 1, blockLimit: 1 })
        const q2 = (o2.memory && o2.memory.chatQueue) || []
        if (q2.some(e => MASTERS.includes(e.from) && !e.acked)) {
          log('[preempt] 批处理中途收到主人消息，停止剩余步骤')
          batch.push({ step: i, skipped: true, reason: 'master spoke' })
          break
        }
      } catch (_) {}
      if (Date.now() - t0 > PLAN_BUDGET_MS) {
        log(`[plan] 批处理已用 ${Math.round((Date.now() - t0) / 1000)}s，停止剩余步骤`)
        batch.push({ step: i, skipped: true, reason: 'time budget' })
        break
      }
    }

    const t = action.type
    const executable = cleanAction(action)
    if (!executable) {
      log(`[guard] 拒绝未知或非法动作: ${JSON.stringify(action).slice(0, 180)}`)
      batch.push({ step: i, action, blocked: 'invalid-action' })
      break
    }
    const key = actionKey(executable)
    plan.absentChestItems = plan.absentChestItems || []

    // 闸门1：箱子缺失物品黑名单硬拦截（防止金鱼记忆反复取物）
    const checkWithdrawBlacklist = (act) => {
      if (!act || typeof act !== 'object') return null
      if (act.type === 'chest' && act.args && act.args.action === 'withdraw' && act.args.item) {
        if (plan.absentChestItems.includes(act.args.item)) return act.args.item
      }
      if (act.type === 'pipeline' && Array.isArray(act.args && act.args.steps)) {
        for (const sub of act.args.steps) {
          const bl = checkWithdrawBlacklist(sub)
          if (bl) return bl
        }
      }
      return null
    }
    const blItem = checkWithdrawBlacklist(executable)
    if (blItem) {
      const blockedMsg = `【硬拦截】箱子实测绝对没有 ${blItem}！严禁重复取物，请更换策略或切换任务。`
      log(`[guard] ${blockedMsg}`)
      plan.lastReflexion = blockedMsg
      savePlan(plan)
      batch.push({ step: i, action: executable, blocked: 'blacklisted-chest-item', error: blockedMsg })
      break
    }

    // 闸门2：细粒度防死循环（既防顶层整动作，也防 pipeline 内部子动作换皮包装）
    const checkSubstepFailures = (act) => {
      if (!act || typeof act !== 'object') return null
      if (act.type === 'pipeline' && Array.isArray(act.args && act.args.steps)) {
        for (const sub of act.args.steps) {
          const subKey = actionKey(sub)
          const rem = plan.failureMemory && plan.failureMemory[subKey]
          if (rem && rem.attempts >= 4) return { subKey, rem }
        }
      }
      return null
    }
    const subFail = checkSubstepFailures(executable)
    if (subFail) {
      log(`[guard] Pipeline 子步骤 ${subFail.subKey} 已连续失败 ${subFail.rem.attempts} 次，拒绝原样重试`)
      batch.push({ step: i, action: executable, blocked: 'repeated-substep-failure', previous: subFail.rem })
      break
    }

    const remembered = plan.failureMemory && plan.failureMemory[key]
    const strategyTag = action.__planMeta && action.__planMeta.strategyTag
    if (remembered && remembered.attempts >= 2 && (!strategyTag || strategyTag === remembered.strategyTag)) {
      log(`[guard] ${key} 已连续失败 ${remembered.attempts} 次，且没有新策略，拒绝原样重试`)
      batch.push({ step: i, action: executable, blocked: 'repeated-failure', previous: remembered })
      break
    }

    try {
      const res = await act(executable)
      const ok = !!(res.ok || (res.result && res.result.ok) || (res.verdict && String(res.verdict).startsWith('PASS')) || (res.result && res.result.verdict && String(res.result.verdict).startsWith('PASS')))
      if (ok) {
        plan.lastReflexion = null
      } else {
        const reflex = (res.result && res.result.reflexion) || res.reflexion || (res.error && res.error.reflexion) || `【动作执行未达标】${res.error || '未满足预期判定'}`
        plan.lastReflexion = reflex
      }
      batch.push({ step: i, action: executable, meta: action.__planMeta || null, ok, result: res.result, error: res.error })
      lastResult = { action: executable, meta: action.__planMeta || null, ok, result: res.result, error: res.error, batchSize: actions.length }
      log(`  [${i + 1}/${actions.length}] ${t} -> ${ok ? 'OK' : 'FAIL'}`, JSON.stringify(res.result || res.error || {}).slice(0, 220))

      plan.failureMemory = plan.failureMemory || {}
      if (ok) {
        delete plan.failureMemory[key]
        // 成功存入物品后，从黑名单中解封
        if (executable.type === 'chest' && executable.args && executable.args.action === 'deposit' && executable.args.item) {
          plan.absentChestItems = plan.absentChestItems.filter(x => x !== executable.args.item)
        }
      } else {
        plan.failureMemory[key] = {
          attempts: (remembered && remembered.errorClass === errorClass(res.error) ? remembered.attempts : 0) + 1,
          errorClass: errorClass(res.error),
          lastError: String(res.error || '').slice(0, 240),
          strategyTag: strategyTag || null,
          at: new Date().toISOString()
        }

        // 自动提取并登记箱子黑名单
        const noItemMatch = String(res.error || '').match(/箱子里没有\s+([a-zA-Z0-9_]+)/)
        if (noItemMatch && noItemMatch[1]) {
          const missingName = noItemMatch[1]
          if (!plan.absentChestItems.includes(missingName)) {
            plan.absentChestItems.push(missingName)
            log(`[chest-guard] 登记箱子缺失物品黑名单: ${missingName}`)
          }
        }

        // 提取 pipeline 中断的具体失败子步骤，精准记录到 failureMemory
        if (executable.type === 'pipeline' && Array.isArray(executable.args && executable.args.steps)) {
          const matchIndex = String(res.error || '').match(/Pipeline 中断于第 (\d+) 步/)
          if (matchIndex && matchIndex[1]) {
            const fIdx = parseInt(matchIndex[1], 10) - 1
            const fStep = executable.args.steps[fIdx]
            if (fStep) {
              const subKey = actionKey(fStep)
              const prevSub = plan.failureMemory[subKey]
              plan.failureMemory[subKey] = {
                attempts: (prevSub ? prevSub.attempts : 0) + 1,
                errorClass: errorClass(res.error),
                lastError: String(res.error || '').slice(0, 240),
                at: new Date().toISOString()
              }
            }
          }
        }
      }

      if (action.__forcedRepair) {
        if (ok) { plan.forcedRepairFails = 0 }
        else {
          plan.forcedRepairFails = (plan.forcedRepairFails || 0) + 1
          if (plan.forcedRepairFails >= 4) {
            plan.forceRepairCooldownUntil = Date.now() + 5 * 60 * 1000
            plan.forcedRepairFails = 0
            log('[GATE] 强制抢修连续失败 4 次 → 熔断 5 分钟，把控制权交还模型')
          }
        }
      }
      plan.history.push({
        at: new Date().toISOString(), action: executable, ok,
        taskId: plan.currentTaskId || null,
        strategyTag: strategyTag || null,
        errorClass: ok ? null : errorClass(res.error),
        evidence: ok ? JSON.stringify(res.result || {}).slice(0, 300) : String(res.error || '').slice(0, 300)
      })
      plan.lastVerifyAt = null
      savePlan(plan)
      if (!ok) {
        // 某一步失败就停止整批：后面的步骤很可能建立在错误前提上
        log(`  [plan] 第 ${i + 1} 步失败，停止后续步骤并交回模型重规划`)
        break
      }

      // 每步后轻量复核真实世界。出现危险，或该步骤未声明 batchSafe，就停止并重新规划。
      if (i < actions.length - 1) {
        try {
          const after = await observe({ entityRadius: 12, blockRadius: 2, blockLimit: 12 })
          const s1 = after.self || {}
          const danger = (s1.health != null && s1.health <= 10) ||
            (after.entities || []).some(e => e.hostile && e.lineOfSight !== false && e.distance <= 8)
          batch[batch.length - 1].observationAfter = {
            position: s1.position || null, health: s1.health, food: s1.food,
            hostiles: (after.entities || []).filter(e => e.hostile && e.distance <= 12).map(e => ({ name: e.name, distance: e.distance }))
          }
          if (danger) {
            log('[plan] 步后复核发现危险，停止批处理并优先保命')
            break
          }
          if (!(action.__planMeta && action.__planMeta.batchSafe === true)) {
            log('[plan] 当前步骤不是 batchSafe，步后重新观察并交回模型规划')
            break
          }
        } catch (e) {
          log('[plan] 步后复核失败，保守停止批处理:', e.message)
          break
        }
      }
    } catch (e) {
      const errMsg = String(e.message || e)
      batch.push({ step: i, action, ok: false, error: errMsg })
      lastResult = { action, ok: false, error: errMsg }
      log('  -> EXEC ERROR', errMsg)
      plan.lastReflexion = e.reflexion || (e.details && e.details.reflexion) || `【动作异常中断】${errMsg}`
      savePlan(plan)
      break
    }
  }

  // 把整批的执行结果写回 lastResult，供下一轮提示词使用（模型能看到每一步真实结果）
  if (batch.length) {
    lastResult = { batch, executedSteps: batch.filter(b => !b.skipped && !b.blocked).length, totalSteps: actions.length }
  }

  return { interval }
}

// ============ 单实例锁 ============
// 曾经的坑：不小心起了两个 friday-brain，两边各自轮询执行器、各自调用大模型，
// 结果是双份回话、动作互相打断、API 花费翻倍。这里用 PID 锁文件彻底避免。
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const txt = String(fs.readFileSync(LOCK_PATH, 'utf8')).trim()
      const pid = Number((txt.match(/^(\d+)/) || [])[1])
      if (pid && pid !== process.pid) {
        let alive = false
        try { process.kill(pid, 0); alive = true } catch (_) { alive = false }
        if (alive) {
          console.error(`[lock] 已经有一个 friday-brain 在运行 (pid ${pid})，本进程退出，避免双份决策。`)
          console.error(`[lock] 如果确认那是残留进程，先 kill ${pid} 或删除 ${LOCK_PATH}`)
          process.exit(3)
        }
      }
    }
    fs.writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`)
  } catch (e) {
    console.error('[lock] 写入锁失败（继续运行）:', e.message)
  }
}
function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return
    const txt = String(fs.readFileSync(LOCK_PATH, 'utf8')).trim()
    const pid = Number((txt.match(/^(\d+)/) || [])[1])
    if (pid === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch (_) {}
}
process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
process.on('unhandledRejection', (err) => {
  try { log('[unhandledRejection]', (err && (err.stack || err.message)) || err) } catch (_) {}
})
process.on('uncaughtException', (err) => {
  try { log('[uncaughtException]', (err && (err.stack || err.message)) || err) } catch (_) {}
})

async function main() {
  acquireLock()
  log('=== FridayAI brain starting ===')
  log('LLM targets:', llmTargets().map(t => t.model).join(' -> '))
  log('executor:', `http://${API_HOST}:${API_PORT}`)
  while (true) {
    let wait = IDLE_INTERVAL_MS
    try {
      const r = await round()
      if (r && r.interval) wait = r.interval
    } catch (e) {
      log('[round error]', e.stack || e.message)
      wait = 8000
    }
    await sleep(wait)
  }
}

main().catch(e => {
  log('fatal:', e.stack || e.message)
  setTimeout(() => main(), 5000)
})
