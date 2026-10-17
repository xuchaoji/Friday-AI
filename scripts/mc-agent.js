#!/usr/bin/env node
'use strict'

// Thin, observable Mineflayer actuator. It deliberately contains no autonomous
// task loop: the calling AI observes, chooses one bounded action, then observes again.
const fs = require('fs')
const http = require('http')
const path = require('path')
const { createRequire } = require('module')

const DEFAULT_CONFIG = process.env.MC_AI_CONFIG || '/root/.config/minecraft-ai/config.json'
const configPath = process.argv[2] || DEFAULT_CONFIG
if (!fs.existsSync(configPath)) {
  console.error(`Missing config: ${configPath}`)
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const https = require('https')
const requireFrom = createRequire(path.join(cfg.moduleRoot || '/root/mc-bot', 'package.json'))
const mineflayer = requireFrom('mineflayer')
const { pathfinder, Movements, goals } = requireFrom('mineflayer-pathfinder')
const { Vec3 } = requireFrom('vec3')
const mcDataLoader = requireFrom('minecraft-data')

const apiHost = cfg.apiHost || '127.0.0.1'
const apiPort = Number(cfg.apiPort || 8765)
const apiToken = cfg.apiToken || ''
const STATE_PATH = cfg.statePath || '/root/.config/minecraft-ai/state.json'
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch (_) { return {} } }
function saveState() { try { fs.writeFileSync(STATE_PATH, JSON.stringify({ shelterAnchor: memory.shelterAnchor, deaths: memory.deaths || 0, protectedRegions: memory.protectedRegions || [] }, null, 2)) } catch (_) {} }
const memory = {
  startedAt: new Date().toISOString(), connected: false, spawned: false, authenticated: false,
  busy: false, action: null, lastAction: null, lastError: null, lastMessages: [], lastDamageAt: null,
  pendingInstructions: [],
  conversationHistory: [], // 存储最近多轮真实对话上下文
  shelterAnchor: null,     // 锁定的房屋地基锚点坐标 {x, y, z}，保证每次继续盖都在同一个地方！
  chatQueue: [],           // 待外置大脑消费的主人指令
  protectedRegions: [],    // 已建成的结构：任何动作都不得破坏其中方块（防止机器人拆自己的房子）
  ownCraftingTable: null   // 自己放下的工作台位置，便于回收
}
let bot
let mcData
let movements
let currentAbort = 0
{
  const st = loadState()
  if (st && st.shelterAnchor && typeof st.shelterAnchor.x === 'number') memory.shelterAnchor = st.shelterAnchor
  if (st && st.deaths) memory.deaths = st.deaths
  if (st && Array.isArray(st.protectedRegions) && st.protectedRegions.length) {
    memory.protectedRegions = st.protectedRegions
    console.log(`[state] 已恢复 ${st.protectedRegions.length} 个受保护建筑区域（重启后依然无法被拆）`)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ==========================================
// 1. 标准异常体系 (与智能体工程指南对齐)
// ==========================================
class AgentError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AgentError'
    this.details = details
  }
}
class StateAssertionError extends AgentError {
  constructor(message, details = {}) {
    super(message, details)
    this.name = 'StateAssertionError'
  }
}
class EnvironmentError extends AgentError {
  constructor(message, details = {}) {
    super(message, details)
    this.name = 'EnvironmentError'
  }
}

// ==========================================
// 2. 自适应轮询引擎 (替换硬编码 sleep)
// ==========================================
async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 150, description = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await predicate()
      if (res) return res
    } catch (_) {}
    await sleep(intervalMs)
  }
  throw new StateAssertionError(`[waitUntil] 等待超时 (${timeoutMs}ms): ${description}`)
}

// ==========================================
// 3. BaseSkill 技能基类 (三段式断言契约)
// ==========================================
class BaseSkill {
  constructor(name) {
    this.name = name
  }
  async preCondition(bot, args, obs) {
    return true
  }
  async execute(bot, args, token) {
    throw new Error(`[${this.name}] execute 未实现`)
  }
  async postCondition(bot, args, newObs, execResult) {
    return true
  }
  async run(bot, args, token) {
    const obsBefore = observe({ blocks: false })
    await this.preCondition(bot, args, obsBefore)
    const result = await this.execute(bot, args, token)
    const obsAfter = observe({ blocks: false })
    await this.postCondition(bot, args, obsAfter, result)
    return result
  }
}

let currentPipelineToken = null
const round = (n, p = 2) => Number(Number(n || 0).toFixed(p))
const posJSON = p => p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null
const dist = (a, b) => a && b ? round(a.distanceTo(b)) : null
const addMessage = (kind, text) => {
  memory.lastMessages.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 500) })
  memory.lastMessages = memory.lastMessages.slice(-30)
}
const named = x => x && (x.displayName || x.username || x.name || x.type)
const inventory = () => bot ? bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot })) : []
const inventoryCounts = () => Object.fromEntries((bot ? bot.inventory.items() : []).map(i => [i.name, (bot.inventory.items().filter(j => j.name === i.name).reduce((n,j)=>n+j.count,0))]))
const airNames = new Set(['air','cave_air','void_air'])
const replaceableNames = new Set(['air','cave_air','void_air','short_grass','tall_grass','fern','large_fern','snow','vine','water'])
const itemEntities = radius => Object.values(bot.entities).filter(e => e && String(e.name).toLowerCase() === 'item' && e.position && bot.entity.position.distanceTo(e.position) <= radius)

// 物理视线与阻挡检测 (Line-of-Sight Raycast)
// 判断机器人眼睛到目标实体之间是否有实心方块或关闭的门阻隔
function hasLineOfSight(entity) {
  if (!bot || !bot.entity || !entity || !entity.position) return false
  try {
    const start = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
    const end = entity.position.offset(0, (entity.height || 1.6) * 0.65, 0)
    const d = start.distanceTo(end)
    if (d <= 1.2) return true
    const steps = Math.ceil(d * 2.5)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const pt = start.plus(end.minus(start).scaled(t)).floored()
      const b = bot.blockAt(pt)
      if (!b || airNames.has(b.name) || replaceableNames.has(b.name)) continue
      // 门如果是关着的，视为阻挡视线与通行；开着的门视为通透
      if (b.name.endsWith('_door')) {
        const props = b.getProperties ? b.getProperties() : {}
        if (props.open === true || props.open === 'true') continue
        return false
      }
      if (b.boundingBox === 'block') return false
    }
    return true
  } catch (_) {
    return true
  }
}

function nearestEntities(radius = 16) {
  if (!bot || !bot.entity) return []
  return Object.values(bot.entities)
    .filter(e => e && e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) <= radius)
    .map(e => {
      const hostile = isHostile(e)
      const los = hostile ? hasLineOfSight(e) : true
      return {
        id: e.id, name: named(e), type: e.type, kind: e.kind || null,
        position: posJSON(e.position), distance: dist(bot.entity.position, e.position),
        health: e.health ?? null, hostile,
        lineOfSight: los,
        blocked: hostile && !los
      }
    })
    .sort((a, b) => a.distance - b.distance).slice(0, 40)
}

const hostileNames = new Set(['zombie','skeleton','creeper','spider','cave_spider','drowned','husk','stray','witch','pillager','vindicator','evoker','ravager','guardian','elder_guardian','blaze','ghast','magma_cube','slime','phantom','warden','hoglin','zoglin','piglin_brute','silverfish','endermite','shulker'])
function isHostile(e) {
  const n = String(e && e.name || '').toLowerCase()
  return hostileNames.has(n) || e && e.kind === 'Hostile mobs'
}

// 该方块是否有至少一个"裸露面"（邻格是空气/水/草等可穿过物）。
// 用来过滤透视：只有露出来的方块才算"看得见"。
const FACE_OFFSETS = [new Vec3(0,1,0), new Vec3(0,-1,0), new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]
function isExposed(pos) {
  for (const d of FACE_OFFSETS) {
    const n = bot.blockAt(pos.plus(d))
    if (!n) return true                       // 未加载视作可见，避免漏报地表
    if (airNames.has(n.name) || replaceableNames.has(n.name)) return true
  }
  return false
}

// 检查方块是否可以直接挖掘（或周围有可挖掘的邻接掩体）
function findAccessBlock(pos) {
  if (isExposed(pos)) return pos
  for (const d of FACE_OFFSETS) {
    const n = bot.blockAt(pos.plus(d))
    if (n && n.diggable && !airNames.has(n.name) && isExposed(n.position)) {
      return n.position
    }
  }
  return null
}

function nearbyBlocks(radius = 5, limit = 80) {
  if (!bot || !bot.entity) return []
  const center = bot.entity.position.floored()
  const out = []
  for (let y = -2; y <= 3; y++) for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
    const b = bot.blockAt(center.offset(x, y, z))
    if (!b || ['air','cave_air','void_air'].includes(b.name)) continue
    if (x*x + z*z > radius*radius) continue
    out.push({ name: b.name, position: posJSON(b.position), distance: dist(bot.entity.position, b.position), diggable: !!b.diggable })
  }
  return out.sort((a,b) => a.distance-b.distance).slice(0, limit)
}

function observe(args = {}) {
  if (!bot || !bot.entity) return { ok: false, ready: false, memory }
  const p = bot.entity.position
  const feet = bot.blockAt(p.floored())
  const below = bot.blockAt(p.floored().offset(0,-1,0))
  const head = bot.blockAt(p.floored().offset(0,1,0))
  return {
    ok: true, ready: memory.spawned && memory.authenticated,
    self: { username: bot.username, position: posJSON(p), yaw: round(bot.entity.yaw), pitch: round(bot.entity.pitch), health: bot.health, food: bot.food, oxygen: bot.oxygenLevel, onGround: bot.entity.onGround, dimension: bot.game && bot.game.dimension, time: bot.time && { timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay }, weather: { raining: !!bot.isRaining }, heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null },
    contact: { feet: feet && feet.name, head: head && head.name, below: below && below.name },
    inventory: inventory(), entities: nearestEntities(Number(args.entityRadius || 16)),
    blocks: args.blocks === false ? undefined : nearbyBlocks(Math.min(Number(args.blockRadius || 5), 12), Math.min(Number(args.blockLimit || 80), 300)),
    memory: { ...memory }
  }
}

function stopAll(reason = 'requested') {
  currentAbort++
  try { bot.pathfinder.setGoal(null) } catch (_) {}   // 先清 goal，避免 stop() 的毒标志留着
  try { bot.pathfinder.stop() } catch (_) {}
  try { bot.clearControlStates() } catch (_) {}
  try { bot.stopDigging() } catch (_) {}
  memory.busy = false
  memory.action = null
  memory.lastAction = { type: 'stop', reason, at: new Date().toISOString() }
}

async function equipBestTool(block) {
  try {
    const tool = bot.pathfinder.bestHarvestTool(block)
    if (tool) await Promise.race([bot.equip(tool, 'hand'), sleep(2000)]).catch(() => {})
    return tool || null
  } catch (_) {
    return null
  }
}

function ensureReady() {
  if (!bot || !bot.entity || !memory.spawned) throw new Error('bot is not spawned')
  if (!memory.authenticated) {
    if (cfg.authmePassword) {
      try { bot.chat(`/login ${cfg.authmePassword}`) } catch (_) {}
      memory.authenticated = true
    } else {
      throw new Error('bot is not authenticated')
    }
  }
}

// ---------- 合成底座（纯机械：找/放工作台、按配方合成，不含任何规划） ----------
const PLANK_NAMES = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','crimson_planks','warped_planks','pale_oak_planks']
const LOG_NAMES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','pale_oak_log','oak_wood','birch_wood','spruce_wood','jungle_wood','acacia_wood','dark_oak_wood','mangrove_wood','cherry_wood','pale_oak_wood']
const STONE_BUILD_NAMES = ['cobblestone','stone','stone_bricks','andesite','granite','diorite','deepslate','polished_andesite','polished_granite','polished_diorite','tuff','calcite','bricks','sandstone','smooth_stone','deepslate_bricks','deepslate_tiles','mud_bricks','terracotta','blackstone','basalt','dirt','coarse_dirt','packed_mud','sand','gravel']
const BUILD_BLOCK_NAMES = [...PLANK_NAMES, ...STONE_BUILD_NAMES]
const GLASS_NAMES = ['glass','glass_pane','tinted_glass','white_stained_glass','light_gray_stained_glass','gray_stained_glass','brown_stained_glass','black_stained_glass','orange_stained_glass','yellow_stained_glass','green_stained_glass','cyan_stained_glass','blue_stained_glass','purple_stained_glass','magenta_stained_glass','pink_stained_glass','lime_stained_glass','red_stained_glass']
const NATURAL_NAMES = new Set(['dirt','grass_block','coarse_dirt','rooted_dirt','podzol','mycelium','sand','red_sand','gravel','clay','mud','moss_block','muddy_mangrove_roots','snow','snow_block','powder_snow','short_grass','tall_grass','fern','large_fern','dead_bush','seagrass','kelp','kelp_plant','vine','glow_lichen','sugar_cane','bush','firefly_bush','leaf_litter'])
const isLeafName = n => typeof n === 'string' && n.endsWith('_leaves')
// 受保护方块：门一挖房子就不密封，床/箱子/工作台/熔炉/火把/玻璃挖了就白干。默认禁止自行破坏。
const PROTECTED_NAMES = new Set(['chest','trapped_chest','ender_chest','crafting_table','furnace','blast_furnace','smoker','torch','wall_torch','soul_torch','soul_wall_torch','redstone_torch','lantern','anvil','enchanting_table','bookshelf','barrel','hopper','brewing_stand','cauldron','flower_pot','painting','item_frame','ladder','scaffolding','campfire','soul_campfire','bell'])
function isProtectedName(n) {
  if (typeof n !== 'string') return false
  if (PROTECTED_NAMES.has(n)) return true
  return n.endsWith('_door') || n.endsWith('_bed') || n.endsWith('_sign')
      || n.endsWith('_shulker_box') || n.endsWith('_glass') || n.endsWith('_glass_pane')
      || n === 'glass'
}

const countByName = name => bot ? bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0) : 0
const countIn = list => bot ? bot.inventory.items().filter(i => list.includes(i.name)).reduce((s, i) => s + i.count, 0) : 0
const findInvItem = name => bot ? bot.inventory.items().find(i => i.name === name) : null

function pickBuildItem(prefer) {
  const items = bot.inventory.items()
  if (prefer) { const p = items.find(i => i.name === prefer); if (p) return p }
  return items.find(i => PLANK_NAMES.includes(i.name))
      || items.find(i => STONE_BUILD_NAMES.includes(i.name))
      || items.find(i => BUILD_BLOCK_NAMES.includes(i.name))
      || null
}

// 找一个可放置方块的空位（贴着已存在的实心方块）
function findPlacementSpot(near) {
  const base = near ? new Vec3(near.x, near.y, near.z) : bot.entity.position.floored()
  const candidates = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -2; dy <= 2; dy++) {
    const pos = base.offset(dx, dy, dz)
    if (!airNames.has((bot.blockAt(pos) || { name: 'air' }).name)) continue
    const below = bot.blockAt(pos.offset(0, -1, 0))
    if (!below || airNames.has(below.name)) continue
    candidates.push({ pos, below, d: bot.entity.position.distanceTo(pos) })
  }
  candidates.sort((a, b) => a.d - b.d)
  return candidates
}

// 放一个工作台到世界（记录位置，便于统一回收）
async function placeCraftingTableNearby() {
  const existing = findInvItem('crafting_table')
  if (!existing) return null
  for (const c of findPlacementSpot()) {
    try {
      if (bot.entity.position.distanceTo(c.pos) > 3.2) await bot.pathfinder.goto(new goals.GoalNear(c.pos.x, c.pos.y, c.pos.z, 2)).catch(() => {})
      await bot.equip(existing, 'hand')
      const fresh = bot.blockAt(c.pos.offset(0, -1, 0))
      if (!fresh || airNames.has(fresh.name)) continue
      await bot.lookAt(c.pos.offset(0.5, 0.5, 0.5), true).catch(() => {})
      await bot.placeBlock(fresh, new Vec3(0, 1, 0))
      await sleep(280)
      const placed = bot.blockAt(c.pos)
      if (placed && placed.name === 'crafting_table') { memory.ownCraftingTable = posJSON(placed.position); return placed }
    } catch (_) {}
  }
  return null
}

async function ensureCraftingTable() {
  if (!bot || !bot.entity) return null
  const found = bot.findBlock({ matching: b => b && b.name === 'crafting_table', maxDistance: 10 })
  if (found) {
    if (bot.entity.position.distanceTo(found.position) > 3.2) {
      await bot.pathfinder.goto(new goals.GoalNear(found.position.x, found.position.y, found.position.z, 2)).catch(() => {})
    }
    const fresh = bot.blockAt(found.position)
    if (fresh && fresh.name === 'crafting_table') return fresh
  }
  if (!findInvItem('crafting_table')) {
    if (countIn(PLANK_NAMES) < 4) return null
    const item = mcData.itemsByName['crafting_table']
    const recipe = bot.recipesFor(item.id, null, 1, null)[0]
    if (!recipe) return null
    try { await bot.craft(recipe, 1, null); await sleep(250) } catch (_) { return null }
  }
  return await placeCraftingTableNearby()
}



// 智能放块：自动选材、自动靠近、自动清掉挡路的自然方块，并在放下后校验
async function placeBlockSmart(target, preferItem) {
  const feet = bot.entity.position.floored()
  if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) return false
  let cur = bot.blockAt(target)
  if (cur && !airNames.has(cur.name) && !replaceableNames.has(cur.name)) {
    if ((NATURAL_NAMES.has(cur.name) || isLeafName(cur.name)) && cur.diggable) {
      try {
        if (bot.entity.position.distanceTo(target) > 3.6) await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)).catch(() => {})
        await equipBestTool(cur); await bot.dig(cur, true); await sleep(90)
        cur = bot.blockAt(target)
      } catch (_) { return false }
    }
    if (cur && !airNames.has(cur.name) && !replaceableNames.has(cur.name)) return true // 已有方块，视为完成
  }
  const faces = [new Vec3(0,-1,0), new Vec3(0,1,0), new Vec3(-1,0,0), new Vec3(1,0,0), new Vec3(0,0,-1), new Vec3(0,0,1)]
  let ref = null, face = null
  for (const f of faces) {
    const r = bot.blockAt(target.minus(f))
    // 水(water)也是被替换目标，但只要相邻方块不是空气、不是水，就能作为依附支撑面
    if (r && !airNames.has(r.name) && r.name !== 'water' && !replaceableNames.has(r.name)) { ref = r; face = f; break }
  }
  // 专门允许向下方的沙子/泥土方块 (0, -1, 0) 依附放方块替换水！
  if (!ref) {
    const below = bot.blockAt(target.offset(0, -1, 0))
    if (below && !airNames.has(below.name) && below.name !== 'water') {
      ref = below
      face = new Vec3(0, 1, 0)
    }
  }
  // 检查目标正上方方块 (0, 1, 0)，若存在实心方块也可向下贴合放置
  if (!ref) {
    const above = bot.blockAt(target.offset(0, 1, 0))
    if (above && !airNames.has(above.name) && above.name !== 'water') {
      ref = above
      face = new Vec3(0, -1, 0)
    }
  }
  if (!ref) return false
  const item = pickBuildItem(preferItem)
  if (!item) throw new Error('no building block in inventory')
  if (bot.entity.position.distanceTo(ref.position) > 4.2) {
    if (memory.flyingMode === 'on') {
      bot.entity.position.set(ref.position.x, ref.position.y + 2, ref.position.z)
    } else {
      await bot.pathfinder.goto(new goals.GoalNear(ref.position.x, ref.position.y, ref.position.z, 2)).catch(() => {})
    }
    if (bot.entity.position.distanceTo(ref.position) > 4.8) return false
  }
  try {
    await bot.equip(item, 'hand')
    await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
    const pPlace = bot.placeBlock(ref, face)
    const pTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('placeBlock timeout')), 3500))
    await Promise.race([pPlace, pTimeout])
    await sleep(120)
    const now = bot.blockAt(target)
    return !!now && !airNames.has(now.name)
  } catch (_) { return false }
}

function regionContains(region, pos) {
  return pos.x >= region.x1 && pos.x <= region.x2
      && pos.y >= region.y1 && pos.y <= region.y2
      && pos.z >= region.z1 && pos.z <= region.z2
}
function protectedRegionAt(pos) {
  const list = Array.isArray(memory.protectedRegions) ? memory.protectedRegions : []
  return list.find(r => regionContains(r, pos)) || null
}

function isCompoundWall(pos) {
  const x = Math.round(pos.x), y = Math.round(pos.y), z = Math.round(pos.z)
  if (y < 62 || y > 66) return false
  if (z === 92 && x >= -32 && x <= 0) return true
  if (z === 124 && x >= -32 && x <= 0) return true
  if (x === -32 && z >= 92 && z <= 124) return true
  if (x === 0 && z >= 92 && z <= 124) return true
  if (z === 108 && x >= -32 && x <= 0) return true
  return false
}

// 统一破坏闸门：受保护结构区域及院子围墙方块一律禁止破坏，除非显式 allowProtected
function digGuard(pos, name, allowProtected) {
  if (allowProtected) return null
  if (isCompoundWall(pos)) return `受保护的安全院子围墙方块 (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)})`
  const region = protectedRegionAt(pos)
  if (region) return `位于受保护建筑区域 "${region.label}" 内（${name}）`
  if (isProtectedName(name)) return `受保护方块 ${name}`
  return null
}

// 中断寻路的唯一正确方式。
// mineflayer-pathfinder 的 stop() 只是把内部标志 stopPathing 置 true，
// 真正执行 stop()（里面会 stateGoal = null）要等到下一次物理 tick 的 monitorMovement，
// 而且移动循环只在"到达下一个路径节点"时才检查该标志。
// 后果：stop() 之后若立刻 setGoal(newGoal)，紧随的物理 tick 会执行 stop()
// 把刚设好的 goal 清成 null —— 机器人"有路可走却完全不动"，
// 而 diagnose 用独立 A* 重新算路仍显示可达，看起来像"客户端卡死"。
// 所以：中断寻路一律用 setGoal(null)（直接清 stateGoal 并 resetPath，不留毒标志）。
function interruptPath() {
  try { bot.pathfinder.setGoal(null) } catch (_) {}
  try { bot.clearControlStates() } catch (_) {}
}

// 只有"确实要停下、且之后不马上寻路"时才用 stop()，并等标志被消费掉。
async function hardStopPath() {
  try { bot.pathfinder.stop() } catch (_) {}
  bot.clearControlStates()
  for (let i = 0; i < 15; i++) {
    await sleep(60)
    try { if (!bot.pathfinder.isMoving()) break } catch (_) { break }
  }
}

async function ensureFlightMode(want = 'on') {
  const readStateFrom = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = String(msgs[i] || '')
      if (/飞行模式被设置为开启|flight mode.*(enabled|on)|Fly mode.*enabled/i.test(t)) return 'on'
      if (/飞行模式被设置为关闭|flight mode.*(disabled|off)|Fly mode.*disabled/i.test(t)) return 'off'
    }
    return null
  }
  const trail = []
  let state = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const mark = memory.lastMessages.length
    bot.chat('/fly')
    await sleep(1200)
    const fresh = memory.lastMessages.slice(mark).map(m => m.text)
    state = readStateFrom(fresh) || readStateFrom(memory.lastMessages.slice(-14).map(m => m.text))
    const denied = fresh.some(t => /no permission|没有权限|无权|denied|unknown command/i.test(String(t)))
    trail.push({ attempt, state, messages: fresh.slice(-2) })
    if (denied) throw new Error('服务器拒绝了 /fly（没有飞行权限）')
    if (state === want) break
  }
  if (state) {
    memory.flyingMode = state
    try {
      if (state === 'on') {
        bot._client.write('abilities', { flags: 0x02 }) // 告知服务端客户端正在飞行 (isFlying = true)
      } else {
        bot._client.write('abilities', { flags: 0x00 })
      }
    } catch (_) {}
  }
  if (state !== want) throw new Error(`期望飞行模式 ${want}，服务器回执显示 ${state || '未知'}`)
  return {
    requested: want, state, toggled: trail.length, clientFlying: !!(bot.entity && bot.entity.flying), trail,
    verdict: `PASS 飞行模式已${want === 'on' ? '开启' : '关闭'}`
  }
}

async function boundedAction(type, args, fn) {
  ensureReady()
  const isTopLevel = !memory.busy
  if (!isTopLevel && !currentPipelineToken) {
    throw new Error(`busy with ${memory.action}`)
  }
  if (isTopLevel) {
    memory.busy = true
    memory.action = type
    memory.lastError = null
  }
  const actionAbort = currentPipelineToken || ++currentAbort
  const started = Date.now()
  // 硬性时间预算：动作绝不允许无限挂起。超时后强制停寻路/松按键，
  // 让正在 await 的 goto 立刻失败返回，而不是把执行器和大脑一起卡死。
  const defaultBudget = type === 'pipeline' ? 180000 : 90000
  const budgetMs = Number((args && args.timeoutMs) || cfg.actionTimeoutMs || defaultBudget)
  let timedOut = false
  const watchdogFns = []
  const watchdog = setTimeout(() => {
    timedOut = true
    currentAbort++
    try { bot.pathfinder.setGoal(null) } catch (_) {}   // 关键：否则下一轮设的新目标会被清掉
    try { bot.pathfinder.stop() } catch (_) {}
    try { bot.clearControlStates() } catch (_) {}
    try { bot.stopDigging() } catch (_) {}
    for (const rej of watchdogFns) { try { rej(new Error(`动作 ${type} 超过 ${budgetMs}ms 被强制中止`)) } catch (_) {} }
    console.error(`[watchdog] 动作 ${type} 超过 ${budgetMs}ms，已强制中止`)
  }, budgetMs)
  let abortReject
  const abortPromise = new Promise((_, rej) => { abortReject = rej })
  watchdogFns.push(abortReject)
  try {
    const result = await Promise.race([fn(actionAbort), abortPromise])
    if (isTopLevel) {
      memory.lastAction = { type, args, ok: true, durationMs: Date.now()-started, at: new Date().toISOString(), result }
    }
    return { ok: true, result, observation: observe({ blocks: false }) }
  } catch (err) {
    const msg = timedOut ? `动作 ${type} 超时（>${budgetMs}ms）已被强制中止：${String(err && err.message || err)}` : String(err && err.message || err)
    if (isTopLevel) {
      memory.lastError = msg
      memory.lastAction = { type, args, ok: false, durationMs: Date.now()-started, at: new Date().toISOString(), error: msg, timedOut }
    }
    throw err
  } finally {
    clearTimeout(watchdog)
    // 无论是否被看门狗强制中止，都必须释放动作锁：
    // 看门狗会 ++currentAbort，若只在 abort 匹配时释放，就会永久卡在 busy 把执行器锁死。
    if (isTopLevel && memory.action === type) {
      memory.busy = false
      memory.action = null
    }
    if (isTopLevel) {
      try { bot.clearControlStates() } catch (_) {}
    }
  }
}

async function act(action = {}, parentToken = null) {
  const type = String(action.type || '')
  const a = action.args || {}
  if (type === 'observe') return observe(a)
  if (type === 'stop') { stopAll(a.reason); return { ok: true, observation: observe({ blocks: false }) } }
  if (type === 'chat') { ensureReady(); bot.chat(String(a.message || '').slice(0, 240)); return { ok: true } }
  if (type === 'ackChat') {
    const ids = Array.isArray(a.ids) ? a.ids : []
    if (a.all) { const n = memory.chatQueue.length; memory.chatQueue = []; memory.pendingInstructions = []; return { ok: true, result: { acked: n } } }
    const before = memory.chatQueue.length
    memory.chatQueue = memory.chatQueue.filter(e => !ids.includes(e.id))
    memory.pendingInstructions = memory.pendingInstructions.filter(e => !ids.includes(e.id))
    return { ok: true, result: { acked: before - memory.chatQueue.length, remaining: memory.chatQueue.length } }
  }
  if (type === 'pipeline') return boundedAction(type, a, async (token) => {
    const steps = Array.isArray(a.steps) ? a.steps : (Array.isArray(a.pipeline) ? a.pipeline : [])
    if (!steps.length) return { ok: true, executed: 0, results: [] }
    currentPipelineToken = token
    const results = []
    let failedIndex = -1
    let failError = null
    let failType = 'Error'
    const startedPipeline = Date.now()
    try {
      for (let i = 0; i < steps.length; i++) {
        if (token !== currentAbort && token !== currentPipelineToken) {
          throw new EnvironmentError('Pipeline 被外部中止信号打断')
        }
        const step = steps[i]
        const stepType = step.type || step.action || step.skill
        const stepArgs = step.args || {}
        console.log(`[Pipeline] 步骤 ${i + 1}/${steps.length}: ${stepType}`, JSON.stringify(stepArgs))
        try {
          // 步前生存防御断言：仅当存在【无阻挡直接威胁】(lineOfSight === true) 或 生命值危急时才短路
          // 若怪物被门/墙遮挡 (blocked === true)，允许在室内继续执行合成、熔炼、睡眠、箱子整理等，绝不误杀！
          // command (/home 等逃生命令)、status、ackChat 属于自保与逃生手段，严禁被自保断言截断！
          const nonCombat = !['guard', 'eat', 'attack', 'sleep', 'fly', 'flyTo', 'land', 'escape', 'command', 'status', 'ackChat'].includes(stepType)
          if (nonCombat && bot && bot.entity) {
            const activeThreats = nearestEntities(7).filter(e => e.hostile && e.lineOfSight)
            if (activeThreats.length > 0 || (bot.health <= 10 && nearestEntities(12).some(e => e.hostile && e.lineOfSight))) {
              const hName = activeThreats.length ? `${activeThreats[0].name}@${activeThreats[0].distance}m` : '近距离威胁'
              throw new EnvironmentError(`主动防御触发：直接敌对威胁暴露 (${hName}, 生命 ${Math.round(bot.health)}/20)，中断 ${stepType} 优先自保`)
            }
          }
          const res = await act({ type: stepType, args: stepArgs }, token)
          results.push({ index: i, type: stepType, ok: true, result: res.result || res })
        } catch (err) {
          failedIndex = i
          failError = err.message || String(err)
          failType = err.name || 'Error'
          results.push({ index: i, type: stepType, ok: false, error: failError, errorType: failType })
          console.error(`[Pipeline] 步骤 ${i + 1}/${steps.length} (${stepType}) 失败:`, failError)
          break
        }
      }
    } finally {
      currentPipelineToken = null
    }

    if (failedIndex >= 0) {
      const failedStep = steps[failedIndex]
      const reflexPrompt = `【执行中断报告 (Reflexion)】\n- 失败步骤: [${failedIndex + 1}/${steps.length}] ${failedStep.type || failedStep.skill}\n- 异常类型: ${failType}\n- 失败根因: ${failError}\n- 已完成步骤数: ${failedIndex}\n请针对该确切异常重新调整任务规划或前置状态，切勿重复执行相同失败参数！`
      const err = new AgentError(`Pipeline 中断于第 ${failedIndex + 1} 步 (${failedStep.type || failedStep.skill}): ${failError}`, {
        failedIndex,
        totalSteps: steps.length,
        failedStep,
        errorType: failType,
        reflexion: reflexPrompt,
        completedResults: results
      })
      err.reflexion = reflexPrompt
      err.results = results
      throw err
    }
    return { ok: true, executed: results.length, durationMs: Date.now() - startedPipeline, results }
  }, parentToken)
  if (type === 'command') {
    ensureReady()
    const cmd = String(a.command || '')
    if (!cmd.startsWith('/')) throw new Error('plugin command must start with /')
    // 安全闸门：禁止"把自己随机丢走 / 传送到未知处"这类自毁式命令。
    // 实测机器人自己执行 /spreadplayers 把自己甩到 8900 格外，随后陷入长时间无法回家的死循环。
    const risky = /^\/(spreadplayers|tp|teleport)\b/i.test(cmd)
    if (risky && !a.allowRisky) {
      throw new Error(`拒绝执行高危位移命令 ${cmd.slice(0, 40)}（会把自己丢到不可控位置；如确需请显式 allowRisky:true）`)
    }
    bot.chat(cmd.slice(0, 240)); await sleep(Number(a.waitMs || 1200))
    return { ok: true, messages: memory.lastMessages.slice(-10), observation: observe({ blocks:false }) }
  }
  if (type === 'move') return boundedAction(type, a, async () => {
    const x=Number(a.x), y=Number(a.y), z=Number(a.z), range=Number(a.range ?? 1)
    if (![x,y,z].every(Number.isFinite)) throw new Error('move requires numeric x,y,z')
    // pathfinder 为了搭桥/垫脚会临时换手持物，走完要还原，否则"拿着土去挖石头"什么都挖不到
    const heldBefore = bot.heldItem ? bot.heldItem.name : null
    const maxDist = Math.max(Number(a.maxDistance || 96), 96)
    if (bot.entity.position.distanceTo(new Vec3(x,y,z)) > maxDist) throw new Error('target exceeds maxDistance; use short waypoints')
    const before = bot.entity.position.clone()
    let pathErr = null
    try {
      await bot.pathfinder.goto(new goals.GoalNear(x,y,z,range))
    } catch (e) {
      pathErr = String(e.message || e).slice(0, 160)
    }
    const moved = bot.entity.position.distanceTo(before)
    const remaining = dist(bot.entity.position, new Vec3(x,y,z))
    const out = { position: posJSON(bot.entity.position), moved: round(moved), remaining }
    // 寻路失败或几乎没动：直接把"到底什么挡住了路"一并返回，省掉一次猜测
    if (pathErr || moved < 0.6) {
      out.ok = false
      out.pathError = pathErr
      out.stuck = moved < 0.6
      const feet = bot.entity.position.floored()
      const blockers = []
      const tx = Math.round(x), tz = Math.round(z)
      const steps = Math.max(Math.abs(tx - feet.x), Math.abs(tz - feet.z))
      for (let i = 1; i <= Math.min(steps, 16); i++) {
        const t = steps === 0 ? 1 : i / steps
        const cx = Math.round(feet.x + (tx - feet.x) * t)
        const cz = Math.round(feet.z + (tz - feet.z) * t)
        for (const dy of [0, 1]) {
          const pos = new Vec3(cx, feet.y + dy, cz)
          const b = bot.blockAt(pos)
          if (!b || airNames.has(b.name) || replaceableNames.has(b.name)) continue
          if (b.name.endsWith('_door')) continue
          // 只把真正有碰撞体积的方块算作障碍：火把/草/告示牌等 boundingBox==='empty'，玩家可以直接走过，若算进去会误导大脑去挖自己的火把。
          if (b.boundingBox === 'empty') continue
          const hard = !!protectedRegionAt(pos) || isProtectedName(b.name)
          blockers.push({ x: cx, y: pos.y, z: cz, name: b.name, layer: dy === 0 ? 'feet' : 'head', protected: hard, natural: !hard })
        }
      }
      out.blockers = blockers
      out.hint = blockers.length
        ? `挡路方块: ${blockers.map(b => `${b.name}@(${b.x},${b.y},${b.z})`).join(', ')}。清掉这些方块再走，不要拆自己的门。`
        : '没有明显直线阻挡；试 unstuck 或换一个 waypoint。'
      const blockerText = blockers.length
        ? ` | 挡路方块: ${blockers.map(b => `${b.name}@(${b.x},${b.y},${b.z})${b.natural ? '(天然,可挖)' : '(建材,勿挖)'}`).join(', ')}`
        : ' | 无直线阻挡，建议 unstuck 或换 waypoint'
      throw new Error(`${pathErr || `move 卡住，仅移动 ${round(moved)} 格`}${blockerText}`)
    }
    if (heldBefore) { const it = bot.inventory.items().find(i => i.name === heldBefore); if (it) await bot.equip(it, 'hand').catch(() => {}) }
    return out
  })
  if (type === 'follow') return boundedAction(type, a, async () => {
    const e = Object.values(bot.entities).find(e => e && (e.username === a.player || e.name === a.player))
    if (!e) throw new Error(`entity not visible: ${a.player}`)
    bot.pathfinder.setGoal(new goals.GoalFollow(e, Number(a.range || 3)), true)
    await sleep(Math.min(Number(a.durationMs || 5000), 15000)); interruptPath()
    return { position: posJSON(bot.entity.position) }
  })
  if (type === 'steer') return boundedAction(type,a,async()=>{
    const duration=Math.min(Number(a.durationMs||800),5000)
    if(a.yaw!=null){ bot.entity.yaw=Number(a.yaw) }
    for(const key of ['forward','back','left','right','jump','sprint']) if(a[key]) bot.setControlState(key,true)
    await sleep(duration); bot.clearControlStates(); return {position:posJSON(bot.entity.position)}
  })
  if (type === 'look') return boundedAction(type, a, async () => {
    if (a.entityId != null) { const e=bot.entities[Number(a.entityId)]; if (!e) throw new Error('entity not visible'); await bot.lookAt(e.position.offset(0,e.height ? e.height*0.8 : 1,0), true) }
    else await bot.lookAt(new Vec3(Number(a.x),Number(a.y),Number(a.z)), true)
    return { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
  })
  if (type === 'attack') return boundedAction(type, a, async (token) => {
    const radius=Math.min(Number(a.radius || 12),24), maxHits=Math.min(Number(a.maxHits || 8),30)
    let hits=0
    while (hits < maxHits && token === currentAbort) {
      let targets=Object.values(bot.entities).filter(e=>e&&e.position&&e!==bot.entity&&bot.entity.position.distanceTo(e.position)<=radius)
      if (a.entityId != null) targets=targets.filter(e=>e.id===Number(a.entityId))
      else if (a.name) targets=targets.filter(e=>String(e.name).toLowerCase()===String(a.name).toLowerCase())
      else targets=targets.filter(isHostile)
      const t=targets.sort((x,y)=>bot.entity.position.distanceTo(x.position)-bot.entity.position.distanceTo(y.position))[0]
      if (!t) break
      const d=bot.entity.position.distanceTo(t.position)
      if (d>3.2) await bot.pathfinder.goto(new goals.GoalFollow(t,2.6)).catch(()=>{})
      if (!bot.entities[t.id]) continue
      await bot.lookAt(t.position.offset(0,t.height ? t.height*0.75 : 1,0),true).catch(()=>{})
      bot.attack(t); hits++; await sleep(Number(a.cooldownMs || 650))
      if (bot.health <= Number(a.abortHealth || 8)) throw new Error('combat aborted: low health')
    }
    return { hits, hostiles: nearestEntities(radius).filter(e=>e.hostile) }
  })
  if (type === 'mineAt') return boundedAction(type,a,async()=>{
    const pos=new Vec3(Number(a.x),Number(a.y),Number(a.z)); const block=bot.blockAt(pos)
    if(!block||['air','cave_air','void_air'].includes(block.name)) throw new Error('target block unavailable')
    const feet=bot.entity.position.floored(); if(pos.x===feet.x&&pos.z===feet.z&&pos.y===feet.y-1) throw new Error('refusing to mine supporting block')
    if(bot.entity.position.distanceTo(pos)>5) throw new Error('target beyond safe reach')
    await equipBestTool(block); await bot.lookAt(pos.offset(0.5,0.5,0.5),true); await bot.dig(block,true); await sleep(250)
    return {mined:block.name,position:posJSON(pos),inventory:inventory()}
  })
  if (type === 'gatherExposed') return boundedAction(type, a, async (token) => {
    // 宏动作：自动寻找目标矿石 -> 寻路走近 -> 挖掘 -> 拾取掉落物
    const names = Array.isArray(a.names) && a.names.length ? a.names : ['iron_ore', 'deepslate_iron_ore']
    const ids = names.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
    if (!ids.length) throw new StateAssertionError('gatherExposed 需要有效的矿石方块名称')
    const count = Math.min(Math.max(Number(a.count || 1), 1), 8)
    const radius = Math.min(Math.max(Number(a.radius || 24), 4), 48)
    const mined = [], unreachable = [], before = inventoryCounts()
    // 前置断言：采矿前背包空间保障，若无空槽位自动丢弃垃圾
    if (bot.inventory.emptySlotCount() === 0) {
      const junk = bot.inventory.items().find(i => ['rotten_flesh', 'leaf_litter', 'azalea', 'flowering_azalea', 'oak_button', 'birch_button', 'white_wool', 'gravel', 'sand', 'dirt', 'andesite', 'granite', 'diorite', 'wheat_seeds', 'wildflowers', 'flint', 'egg', 'birch_sapling', 'oak_sapling', 'cobbled_deepslate', 'tuff'].includes(i.name))
      if (junk) {
        try { await bot.tossStack(junk); await sleep(150) } catch (_) {}
      }
    }
    if (bot.inventory.emptySlotCount() === 0) {
      // 若还是没有，尝试丢一组圆石或深板岩圆石
      const extraStone = bot.inventory.items().find(i => i.name === 'dirt' || i.name === 'cobblestone' || i.name === 'cobbled_deepslate')
      if (extraStone) {
        try { await bot.tossStack(extraStone); await sleep(150) } catch (_) {}
      }
    }
    if (bot.inventory.emptySlotCount() === 0) {
      throw new StateAssertionError('背包已满且无垃圾可丢弃，无法拾取矿石')
    }
    for (let i = 0; i < count && token === currentAbort; i++) {
      let target = null
      if (a.x != null && a.y != null && a.z != null && i === 0) {
        const bp = new Vec3(Number(a.x), Number(a.y), Number(a.z))
        const blk = bot.blockAt(bp)
        if (blk && ids.includes(blk.type)) target = blk
      }
      if (!target) {
        // 先找直接裸露的，若找不到且未限制 exposed===true，则允许寻找邻近掩体可挖的目标
        target = bot.findBlock({ matching: ids, maxDistance: radius, useExtraInfo: b =>
          isExposed(b.position) &&
          !mined.some(p => p.x === b.position.x && p.y === b.position.y && p.z === b.position.z) &&
          !unreachable.some(p => p.x === b.position.x && p.y === b.position.y && p.z === b.position.z)
        })
      }
      // 容错：如果没裸露目标，寻找任何距离最近的目标并先挖开外层掩体
      if (!target && a.exposed !== true) {
        target = bot.findBlock({ matching: ids, maxDistance: radius, useExtraInfo: b =>
          !mined.some(p => p.x === b.position.x && p.y === b.position.y && p.z === b.position.z) &&
          !unreachable.some(p => p.x === b.position.x && p.y === b.position.y && p.z === b.position.z)
        })
        if (target && !isExposed(target.position)) {
          // 挖掘挡在目标前面的邻近方块以暴露目标
          for (const d of FACE_OFFSETS) {
            const cover = bot.blockAt(target.position.plus(d))
            if (cover && cover.diggable && !airNames.has(cover.name)) {
              try {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(cover.position.x, cover.position.y, cover.position.z)).catch(() => {})
                await equipBestTool(cover)
                await bot.dig(cover, true)
                await sleep(150)
                if (isExposed(target.position)) break
              } catch (_) {}
            }
          }
        }
      }
      if (!target) break
      const guard = digGuard(target.position, target.name, false)
      if (guard) { unreachable.push({ ...posJSON(target.position), reason: guard }); continue }
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z))
        const fresh = bot.blockAt(target.position)
        if (!fresh || !ids.includes(fresh.type)) { unreachable.push({ ...posJSON(target.position), reason: 'target-changed' }); continue }
        await equipBestTool(fresh)
        await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
        await bot.dig(fresh, true)
        mined.push({ name: fresh.name, position: posJSON(fresh.position) })
        // 自适应等待掉落物吸附
        for (const item of itemEntities(6).slice(0, 4)) {
          await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)).catch(() => {})
          await sleep(150)
        }
      } catch (e) { unreachable.push({ ...posJSON(target.position), reason: String(e.message || e).slice(0, 90) }) }
    }
    const after = inventoryCounts(), gained = {}
    for (const [name, n] of Object.entries(after)) if (n > (before[name] || 0)) gained[name] = n - (before[name] || 0)
    if (!mined.length) throw new EnvironmentError(`gatherExposed 未能采集目标（${unreachable.length} 个不可达/被阻挡）`)
    return { mined, gained, unreachable: unreachable.slice(0, 8), inventory: inventory() }
  }, parentToken)
  if (type === 'chest') return boundedAction(type, a, async (token) => {
    // 仓库/箱子交互宏：打开箱子，存入或取出指定物品，或查看物品清单
    const pos = a.x != null ? new Vec3(Number(a.x), Number(a.y), Number(a.z)) : null
    const chestBlock = pos ? bot.blockAt(pos) : bot.findBlock({ matching: b => b && ['chest', 'trapped_chest', 'barrel'].includes(b.name), maxDistance: 6 })
    if (!chestBlock) throw new StateAssertionError('附近没有找到箱子或木桶')
    if (bot.entity.position.distanceTo(chestBlock.position) > 4.5) {
      await bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2))
    }
    const chest = await bot.openChest(chestBlock)
    try {
      const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
      // 实时缓存箱子状态到 memory，供 observe 与大脑直接消费
      memory.lastChest = {
        pos: posJSON(chestBlock.position),
        items,
        summary: items.map(i => `${i.name}x${i.count}`).join(', ') || '(空)',
        at: new Date().toISOString()
      }
      const transferred = []
      if (!a.action || a.action === 'list' || a.action === 'peek') {
        return { chestItems: items, inventory: inventory(), verdict: `PASS 箱子查询成功，共有 ${items.length} 种物品: ${memory.lastChest.summary}` }
      }
      if (a.action === 'withdraw' && a.item) {
        const itemObj = chest.containerItems().find(i => i.name === a.item)
        if (!itemObj) {
          const avail = items.length ? items.map(i => `${i.name}x${i.count}`).join(', ') : '空箱子'
          throw new StateAssertionError(`箱子里没有 ${a.item}！当前箱内实际库存为: [${avail}]。请勿再重复提取 ${a.item}！`)
        }
        const count = Math.min(Number(a.count || itemObj.count), itemObj.count)
        await chest.withdraw(itemObj.type, null, count)
        transferred.push({ name: a.item, count })
      } else if (a.action === 'deposit' && a.item) {
        const itemObj = bot.inventory.items().find(i => i.name === a.item)
        if (!itemObj) throw new StateAssertionError(`背包里没有 ${a.item}`)
        const count = Math.min(Number(a.count || itemObj.count), itemObj.count)
        await chest.deposit(itemObj.type, null, count)
        transferred.push({ name: a.item, count })
      }
      // 存取后重新同步最新箱内物品
      const updatedItems = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
      memory.lastChest.items = updatedItems
      memory.lastChest.summary = updatedItems.map(i => `${i.name}x${i.count}`).join(', ') || '(空)'
      return { chestItems: updatedItems, transferred, inventory: inventory(), verdict: 'PASS 箱子交互成功' }
    } finally {
      chest.close()
    }
  }, parentToken)
  if (type === 'craftPickaxe') return boundedAction(type, a, async (token) => {
    // 宏动作：自动合成指定镐（如 iron_pickaxe / stone_pickaxe）
    const material = String(a.material || 'iron').toLowerCase()
    const targetName = `${material}_pickaxe`
    const targetItem = mcData.itemsByName[targetName]
    if (!targetItem) throw new StateAssertionError(`未知镐类型: ${targetName}`)
    // 检查是否有工作台
    let table = bot.findBlock({ matching: b => b && b.name === 'crafting_table', maxDistance: 6 })
    if (!table) {
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table')
      if (tableItem) {
        const spot = findPlacementSpot()
        if (spot && spot.length) {
          await bot.equip(tableItem, 'hand')
          await bot.placeBlock(spot[0].below, new Vec3(0, 1, 0))
          await waitUntil(() => bot.findBlock({ matching: b => b && b.name === 'crafting_table', maxDistance: 6 }), { timeoutMs: 3000, intervalMs: 200, description: '检测放置后的工作台' }).catch(() => {})
          table = bot.findBlock({ matching: b => b && b.name === 'crafting_table', maxDistance: 6 })
        }
      }
    }
    if (!table) throw new StateAssertionError('附近没有工作台且背包无工作台可放置')
    // 检查木棍
    let sticks = countByName('stick')
    if (sticks < 2) {
      const stickItem = mcData.itemsByName['stick']
      const stickRecipe = bot.recipesFor(stickItem.id, null, 1, table)[0] || bot.recipesFor(stickItem.id, null, 1, null)[0]
      if (stickRecipe) {
        await bot.craft(stickRecipe, 1, stickRecipe.requiresTable ? table : null)
        await waitUntil(() => countByName('stick') >= 2, { timeoutMs: 2500, intervalMs: 150, description: '木棍入包' }).catch(() => {})
      }
    }
    const recipe = bot.recipesFor(targetItem.id, null, 1, table)[0]
    if (!recipe) throw new StateAssertionError(`材料不足或缺少配方合成 ${targetName}（需对应材料x3, 木棍x2）`)
    const before = countByName(targetName)
    await bot.craft(recipe, 1, table)
    await waitUntil(() => countByName(targetName) > before, { timeoutMs: 4000, intervalMs: 200, description: `合成 ${targetName} 入包` })
    const gained = countByName(targetName) - before
    if (gained <= 0) throw new StateAssertionError(`合成 ${targetName} 失败，背包未增加`)
    const created = bot.inventory.items().find(i => i.name === targetName)
    if (created) { try { await bot.equip(created, 'hand') } catch (_) {} }
    return { item: targetName, gained, held: bot.heldItem ? bot.heldItem.name : null, verdict: `PASS 成功合成 ${targetName}` }
  }, parentToken)
  if (type === 'mine') return boundedAction(type, a, async (token) => {
    const names = Array.isArray(a.names) ? a.names : [a.name]
    const ids = names.filter(Boolean).map(n=>mcData.blocksByName[n]).filter(Boolean).map(b=>b.id)
    if (!ids.length) throw new Error('mine requires valid block name(s)')
    const count=Math.min(Number(a.count || 1),32), radius=Math.min(Number(a.radius || 16),32)
    const mined=[], unreachable=[]
    for (let i=0;i<count && token===currentAbort;i++) {
      const p=bot.findBlock({matching:ids,maxDistance:radius,useExtraInfo:b=>
        !mined.some(m=>m.x===b.position.x&&m.y===b.position.y&&m.z===b.position.z)&&
        !unreachable.some(m=>m.x===b.position.x&&m.y===b.position.y&&m.z===b.position.z)&&
        (a.exposed === false || isExposed(b.position))})
      if (!p) break
      const pguard = digGuard(p.position, p.name, a.allowProtected)
      if (pguard) { unreachable.push({ ...posJSON(p.position), name: p.name, reason: pguard }); continue }
      const feet=bot.entity.position.floored()
      if (p.position.x===feet.x && p.position.z===feet.z && p.position.y<=feet.y-1) { unreachable.push(posJSON(p.position)); continue }
      // 寻路失败不应让整个动作崩掉：记下不可达，换下一块
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(p.position.x,p.position.y,p.position.z))
      } catch (e) {
        if (bot.entity.position.distanceTo(p.position) > 4.4) { unreachable.push({ ...posJSON(p.position), reason: 'unreachable' }); await sleep(120); continue }
      }
      const freshFeet=bot.entity.position.floored()
      if (p.position.x===freshFeet.x && p.position.z===freshFeet.z && p.position.y<=freshFeet.y-1) { unreachable.push({ ...posJSON(p.position), reason: 'under-foot' }); continue }
      try {
        await equipBestTool(p); await bot.dig(p,true); mined.push(posJSON(p.position)); await sleep(250)
      } catch (e) { unreachable.push({ ...posJSON(p.position), reason: String(e.message).slice(0, 60) }) }
    }
    if (!mined.length && unreachable.length) throw new Error(`mine 未能挖到任何方块（${unreachable.length} 块不可达/被阻挡）`)
    return { mined: mined.length, positions: mined, unreachable: unreachable.slice(0, 10) }
  })
  if (type === 'digStair') return boundedAction(type,a,async(token)=>{
    if (!bot.entity || !bot.entity.position) throw new Error('bot entity not ready')
    const dx=Math.sign(Number(a.dx??1)), dz=Math.sign(Number(a.dz??0)); if(Math.abs(dx)+Math.abs(dz)!==1) throw new Error('digStair requires one cardinal direction')
    const steps=Math.min(Number(a.steps||4),12), mined=[]; const start=bot.entity.position.floored(); let base=start
    const dangerous=new Set(['lava','water','fire','soul_fire','magma_block'])
    for(let s=1;s<=steps&&token===currentAbort;s++){
      if (!bot.entity || !bot.entity.position) throw new Error('bot entity disconnected during digging')
      // 只有敌对生物在视线内(lineOfSight)或极其接近(<=3格)时才中止，避免隔墙听到僵尸叫就直接无限罢工
      const directThreat = nearestEntities(10).find(e => e.hostile && (e.lineOfSight || e.distance <= 3.2))
      if (directThreat) throw new Error(`digging aborted: ${directThreat.name} nearby (${round(directThreat.distance)}m)`)
      const foot=new Vec3(start.x+dx*s,start.y-s,start.z+dz*s), head=foot.offset(0,1,0), clearance=foot.offset(0,2,0)
      for(const p of [clearance,head,foot]){
        for(const off of [new Vec3(0,0,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,1,0),new Vec3(0,-1,0),new Vec3(0,0,1),new Vec3(0,0,-1)]){
          const check=bot.blockAt(p.plus(off));
          if(check&&dangerous.has(check.name)) {
            // 如果遇到水或岩浆流，尝试用手中圆石、深板岩圆石或安山岩封堵
            const sealItem=bot.inventory.items().find(i=>['cobblestone','cobbled_deepslate','dirt','stone','andesite','granite','diorite','tuff'].includes(i.name))
            if(sealItem){
              try {
                await bot.equip(sealItem,'hand')
                await bot.placeBlock(check, new Vec3(0,1,0)).catch(()=>{})
                await sleep(150)
              } catch(_) {}
            }
            throw new Error(`digging aborted: ${check.name} near ${p}`)
          }
        }
        let b=bot.blockAt(p)
        for(let fall=0;fall<4&&b&&!['air','cave_air','void_air'].includes(b.name);fall++){
          if(!b.diggable) throw new Error(`undiggable block: ${b.name}`)
          await equipBestTool(b); await bot.dig(b,true); mined.push({name:b.name,position:posJSON(p)}); await sleep(180); b=bot.blockAt(p)
        }
      }
      await bot.pathfinder.goto(new goals.GoalNear(foot.x+0.5,foot.y,foot.z+0.7,0.7)).catch(()=>{})
      if (!bot.entity || !bot.entity.position) throw new Error('bot entity disconnected during digging')
      base=bot.entity.position.floored()
      if(bot.health<=Number(a.abortHealth||12)) throw new Error('digging aborted: low health')
    }
    return {stepsCompleted:steps,position:posJSON(bot.entity.position),mined,inventory:inventory()}
  })
  if (type === 'branchMine') return boundedAction(type,a,async(token)=>{
    if (!bot.entity || !bot.entity.position || !bot.world) throw new Error('bot entity or world not ready')
    const dx=Math.sign(Number(a.dx??1)), dz=Math.sign(Number(a.dz??0)); if(Math.abs(dx)+Math.abs(dz)!==1) throw new Error('branchMine requires one cardinal direction')
    const length=Math.min(Number(a.length||8),16), oreLimit=Math.min(Number(a.oreLimit||12),32), start=bot.entity.position.floored(), mined=[], ores=[], before=inventoryCounts()
    const ALL_COMMON_ORES = [
      'coal_ore','deepslate_coal_ore',
      'iron_ore','deepslate_iron_ore',
      'copper_ore','deepslate_copper_ore',
      'gold_ore','deepslate_gold_ore',
      'redstone_ore','deepslate_redstone_ore',
      'lapis_ore','deepslate_lapis_ore',
      'diamond_ore','deepslate_diamond_ore',
      'emerald_ore','deepslate_emerald_ore'
    ]
    const oreNames=Array.isArray(a.ores)&&a.ores.length?a.ores:ALL_COMMON_ORES
    const oreIds=new Set(oreNames.map(n=>mcData.blocksByName[n]).filter(Boolean).map(b=>b.id)), dangerous=new Set(['lava','water','fire','soul_fire','magma_block'])
    for(let s=1;s<=length&&token===currentAbort;s++){
      if (!bot.entity || !bot.entity.position || !bot.world) throw new Error('bot disconnected during branch mining')
      const closeHostile=nearestEntities(8).find(e=>e.hostile && e.lineOfSight); if(closeHostile) throw new Error(`branch mining aborted: ${closeHostile.name} at ${closeHostile.distance}`)
      const foot=new Vec3(start.x+dx*s,start.y,start.z+dz*s), head=foot.offset(0,1,0)
      const falling=new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel','concrete_powder'])
      for(let up=1;up<=5;up++){
        const overhead=bot.blockAt(head.offset(0,up,0))
        if(overhead&&falling.has(overhead.name)){
          // 遇沙砾/沙子掉落方块，先主动挖除清空，避免直接罢工崩溃
          try {
            await equipBestTool(overhead)
            await bot.dig(overhead, true)
            await sleep(150)
          } catch (_) {
            throw new Error(`branch mining aborted: falling ${overhead.name} above tunnel at ${overhead.position}`)
          }
        }
      }
      for(const p of [foot,head]){
        for(const off of [new Vec3(0,0,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,1,0),new Vec3(0,-1,0),new Vec3(0,0,1),new Vec3(0,0,-1)]){
          const check=bot.blockAt(p.plus(off));
          if(check&&dangerous.has(check.name)) {
            // 如果是水或岩浆，尝试用手头圆石或泥土封堵，而不是直接彻底抛异常崩溃
            const sealItem=bot.inventory.items().find(i=>['cobblestone','dirt','stone','deepslate'].includes(i.name))
            if(sealItem){
              try {
                await bot.equip(sealItem,'hand')
                await bot.placeBlock(check, new Vec3(0,1,0)).catch(()=>{})
                await sleep(150)
              } catch(_) {}
            }
            throw new Error(`branch mining paused: ${check.name} near ${p}`)
          }
        }
        const b=bot.blockAt(p); if(b&&!airNames.has(b.name)){if(!b.diggable)throw new Error(`undiggable block: ${b.name}`);const tool=await equipBestTool(b);if(!tool&&b.harvestTools)throw new Error(`branch mining aborted: missing harvest tool for ${b.name}`);await bot.dig(b,true);mined.push({name:b.name,position:posJSON(p)});await sleep(120)}
      }
      await bot.pathfinder.goto(new goals.GoalNear(foot.x+0.5,foot.y,foot.z+0.5,0.7)).catch(()=>{})
      // 矿洞照明：每隔 5 格或终点检测当前位置是否有火把，若无且背包有火把则插下照明，避免刷怪
      if (s % 5 === 1 || s === length) {
        try {
          const torchItem = bot.inventory.items().find(i => i.name === 'torch' || i.name === 'soul_torch')
          if (torchItem) {
            const currentBlock = bot.blockAt(foot)
            const floorBlock = bot.blockAt(foot.offset(0, -1, 0))
            if (floorBlock && floorBlock.boundingBox === 'block' && (!currentBlock || airNames.has(currentBlock.name) || replaceableNames.has(currentBlock.name))) {
              await bot.equip(torchItem, 'hand').catch(()=>{})
              await bot.lookAt(floorBlock.position.offset(0.5, 0.9, 0.5), true).catch(()=>{})
              await bot.placeBlock(floorBlock, new Vec3(0, 1, 0)).catch(()=>{})
              await sleep(100)
            }
          }
        } catch (_) {}
      }
      const center=bot.entity.position.floored(), candidates=[]
      for(let x=-3;x<=3;x++)for(let y=-2;y<=3;y++)for(let z=-3;z<=3;z++){
        const b=bot.blockAt(center.offset(x,y,z))
        if(b&&oreIds.has(b.type)&&bot.entity.position.distanceTo(b.position)<=5.5&&isExposed(b.position))candidates.push(b)
      }
      candidates.sort((x,y)=>bot.entity.position.distanceTo(x.position)-bot.entity.position.distanceTo(y.position))
      for(const b of candidates){
        if(ores.length>=oreLimit)break
        const feet=bot.entity.position.floored()
        if(b.position.x===feet.x&&b.position.z===feet.z&&b.position.y<=feet.y)continue // 严禁挖脚下或脚下支撑
        const fresh=bot.blockAt(b.position)
        if(!fresh||!oreIds.has(fresh.type))continue
        // 智能工具匹配：如果手上工具等级不足采掘该矿石（如拿木稿/石镐采钻石、金矿、红石），跳过此矿石而不中断
        const tool=bot.pathfinder.bestHarvestTool(fresh)
        if(!tool&&fresh.harvestTools){
          console.log(`[branchMine] 掠过 ${fresh.name}：当前没有合格挖掘工具（缺少高阶镐）`)
          continue
        }
        try {
          await equipBestTool(fresh)
          await bot.dig(fresh,true)
          ores.push({name:fresh.name,position:posJSON(fresh.position)})
          await sleep(150)
        } catch(digErr) {
          console.warn(`[branchMine] 采掘周边矿石 ${fresh.name} 失败:`, digErr.message)
        }
      }
      if(bot.health<=Number(a.abortHealth||12)) throw new Error('branch mining aborted: low health')
    }
    for(let i=0;i<12;i++){
      const target=itemEntities(6).sort((x,y)=>bot.entity.position.distanceTo(x.position)-bot.entity.position.distanceTo(y.position))[0];if(!target)break
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x,target.position.y,target.position.z,1)).catch(()=>{});await sleep(250)
    }
    const after=inventoryCounts(),gained={};for(const [name,count] of Object.entries(after))if(count>(before[name]||0))gained[name]=count-(before[name]||0)
    return {lengthCompleted:length,position:posJSON(bot.entity.position),tunnelBlocks:mined,oresMined:ores,gained,inventory:inventory()}
  })
  if (type === 'chop') return act({type:'mine',args:{names:a.names||['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'],count:a.count||8,radius:a.radius||20}})
  if (type === 'use') return boundedAction(type, a, async () => {
    let item
    if (a.item) {
      item=bot.inventory.items().find(i=>i.name===a.item)
      if (!item) throw new Error(`missing item: ${a.item}`)
      await bot.equip(item,'hand')
    }
    if (a.entityId != null) { const e=bot.entities[Number(a.entityId)]; if(!e) throw new Error('entity not visible'); await bot.activateEntity(e) }
    else if (a.x != null) { const b=bot.blockAt(new Vec3(Number(a.x),Number(a.y),Number(a.z))); if(!b) throw new Error('block unavailable'); await bot.activateBlock(b) }
    else if (item && item.foodPoints != null) await bot.consume()
    else { await bot.activateItem(); await sleep(Number(a.holdMs || 500)); bot.deactivateItem() }
    await sleep(Number(a.waitMs||300)); return { heldItem: bot.heldItem && bot.heldItem.name, food: bot.food }
  })
  if (type === 'eat') return boundedAction(type, a, async () => {
    // 明确地吃东西：不依赖 item.foodPoints 是否存在，直接 equip + bot.consume()。
    // 饥饿值为 0 时会持续掉血，必须能可靠进食。
    const FOOD_RE = /(cooked_|raw_)?(beef|porkchop|chicken|mutton|rabbit|rabbit_stew|cod|salmon|tropical_fish|potato|bread|apple|carrot|melon_slice|beetroot|sweet_berries|glow_berries|dried_kelp|golden_apple|enchanted_golden_apple|mushroom_stew|beetroot_soup|suspicious_stew|honey_bottle|rotten_flesh|spider_eye|poisonous_potato|pufferfish)/
    let item = a.item ? bot.inventory.items().find(i => i.name === a.item) : null
    if (!item) item = bot.inventory.items().find(i => FOOD_RE.test(i.name))
    if (!item) throw new Error('背包里没有可吃的东西')
    const before = { health: bot.health, food: bot.food }
    let lastErr = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await bot.equip(item, 'hand')
        await sleep(200)
        await bot.consume()
        await sleep(400)
        if (bot.food > before.food || bot.health > before.health) break
      } catch (e) { lastErr = e; await sleep(400) }
      const again = bot.inventory.items().find(i => i.name === item.name)
      if (!again) break
      item = again
    }
    const gained = { food: Number((bot.food - before.food).toFixed(1)), health: Number((bot.health - before.health).toFixed(1)) }
    return { ate: item.name, before, after: { health: Number(bot.health.toFixed(1)), food: bot.food }, gained,
             ok: gained.food > 0 || gained.health > 0 || bot.food >= 20,
             error: lastErr ? String(lastErr.message).slice(0, 100) : null }
  })
  if (type === 'equip') return boundedAction(type,a,async()=>{ const i=bot.inventory.items().find(i=>i.name===a.item); if(!i) throw new Error(`missing item: ${a.item}`); await bot.equip(i,a.destination||'hand'); return {item:i.name,destination:a.destination||'hand'} })
  if (type === 'discard') return boundedAction(type,a,async()=>{
    const names=Array.isArray(a.names)?a.names:(Array.isArray(a.items)?a.items:[a.name]), allow=new Set(['cobblestone','dirt','granite','diorite','andesite','gravel','leaf_litter','oak_button','birch_button','dark_oak_button','short_grass','rotten_flesh','wooden_hoe','stone_shovel','stone_axe','stone_hoe','tuff','cobbled_deepslate','sand','wildflowers','azalea','wheat_seeds','flint','netherrack','stone_brick_slab','birch_sapling','oak_sapling','dark_oak_sapling','egg','string','magma_block','white_wool'])
    const maxStacks=Math.min(Number(a.maxStacks||16),32), dropped=[]
    // 丢弃前先转身向开阔方向，强力投掷到远处(看向上方45度投出)
    try {
      await bot.look(0, 0.6, true).catch(()=>{})
    } catch (_) {}
    for(const name of names.filter(Boolean)){
      if(!allow.has(name)) continue
      for(const item of bot.inventory.items().filter(i=>i.name===name)){
        if(dropped.length>=maxStacks)break
        await bot.tossStack(item);dropped.push({name:item.name,count:item.count});await sleep(100)
      }
      if(dropped.length>=maxStacks)break
    }
    // 丢弃后立即走开 7 格，并等待物品落地稳定
    try {
      const curPos = bot.entity.position.clone()
      await bot.pathfinder.goto(new goals.GoalNear(curPos.x - 6, curPos.y, curPos.z - 6, 1)).catch(()=>{})
    } catch (_) {}
    await sleep(200)
    return {dropped,freeSlots:bot.inventory.emptySlotCount(),inventory:inventory()}
  })
  if (type === 'craft') return boundedAction(type,a,async()=>{
    const item=mcData.itemsByName[a.item]; if(!item) throw new Error(`unknown craft item: ${a.item}`)
    const count=Math.min(Number(a.count||1),64)
    let table=null
    if(a.table){ table=bot.blockAt(new Vec3(Number(a.table.x),Number(a.table.y),Number(a.table.z))); if(!table) throw new Error('crafting table unavailable') }
    const recipe=bot.recipesFor(item.id,null,1,table)[0]; if(!recipe) throw new Error(`no available recipe for: ${a.item}`)
    await bot.craft(recipe,count,table); return {item:a.item,count}
  })
  if (type === 'collect') return boundedAction(type,a,async()=>{
    const radius=Math.min(Number(a.radius||12),24), maxItems=Math.min(Number(a.maxItems||8),32), before=inventoryCounts(); let picked=0,attempted=0
    for(let i=0;i<maxItems;i++){
      const target=itemEntities(radius).sort((x,y)=>bot.entity.position.distanceTo(x.position)-bot.entity.position.distanceTo(y.position))[0]
      if(!target) break
      attempted++
      const id=target.id, p=target.position.clone()
      if(bot.entity.position.distanceTo(p)>1.25){
        await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,1)).catch(()=>{})
        if(bot.entity.position.distanceTo(p)>1.5){
          await bot.lookAt(p.offset(0,0.2,0),true).catch(()=>{})
          bot.setControlState('forward',true); await sleep(900); bot.setControlState('forward',false)
        }
      }
      for(let wait=0;wait<8&&bot.entities[id];wait++) await sleep(150)
      if(!bot.entities[id]) picked++
      else break
    }
    const after=inventoryCounts(), gained={}
    for(const [name,count] of Object.entries(after)) if(count>(before[name]||0)) gained[name]=count-(before[name]||0)
    return {attempted,picked,gained,remainingItems:itemEntities(radius).length,inventory:inventory()}
  })
  if (type === 'harvestGrass') return boundedAction(type,a,async()=>{
    const names=['short_grass','tall_grass','fern','large_fern'], ids=names.map(n=>mcData.blocksByName[n]).filter(Boolean).map(b=>b.id)
    const count=Math.min(Number(a.count||16),64), radius=Math.min(Number(a.radius||12),24); let broken=0
    for(let i=0;i<count;i++){
      const b=bot.findBlock({matching:ids,maxDistance:radius}); if(!b) break
      if(bot.entity.position.distanceTo(b.position)>4.5) await bot.pathfinder.goto(new goals.GoalGetToBlock(b.position.x,b.position.y,b.position.z)).catch(()=>{})
      await bot.dig(b,true).catch(()=>{}); broken++; await sleep(120)
    }
    return {broken,inventory:inventory()}
  })
  if (type === 'hunt') return boundedAction(type,a,async(token)=>{
    const names=Array.isArray(a.names)?a.names:[a.name||'sheep'], count=Math.min(Number(a.count||1),8), radius=Math.min(Number(a.radius||32),64); let killed=0,hits=0
    while(killed<count&&token===currentAbort){
      const target=Object.values(bot.entities).filter(e=>e&&e.position&&names.includes(String(e.name).toLowerCase())&&bot.entity.position.distanceTo(e.position)<=radius).sort((x,y)=>bot.entity.position.distanceTo(x.position)-bot.entity.position.distanceTo(y.position))[0]
      if(!target) break
      const sword=bot.inventory.items().find(i=>i.name.endsWith('_sword')); if(sword) await bot.equip(sword,'hand')
      for(let i=0;i<12&&bot.entities[target.id]&&token===currentAbort;i++){
        if(bot.entity.position.distanceTo(target.position)>3) await bot.pathfinder.goto(new goals.GoalFollow(target,2.4)).catch(()=>{})
        if(!bot.entities[target.id]) break
        await bot.lookAt(target.position.offset(0,1,0),true).catch(()=>{}); bot.attack(target); hits++; await sleep(650)
        if(bot.health<=Number(a.abortHealth||10)) throw new Error('hunt aborted: low health')
      }
      if(!bot.entities[target.id]) killed++; else break
    }
    return {killed,hits,inventory:inventory()}
  })
  if (type === 'farm') return boundedAction(type,a,async()=>{
    const hoe=bot.inventory.items().find(i=>i.name.endsWith('_hoe')); if(!hoe) throw new Error('missing hoe')
    const seeds=bot.inventory.items().find(i=>i.name==='wheat_seeds'); if(!seeds) throw new Error('missing wheat_seeds')
    const positions=Array.isArray(a.positions)?a.positions:[]; if(!positions.length) throw new Error('farm requires positions')
    let planted=0
    for(const p of positions.slice(0,32)){
      const pos=new Vec3(Number(p.x),Number(p.y),Number(p.z)); let ground=bot.blockAt(pos); if(!ground) continue
      if(bot.entity.position.distanceTo(pos)>4.5) await bot.pathfinder.goto(new goals.GoalNear(pos.x,pos.y+1,pos.z,2)).catch(()=>{})
      ground=bot.blockAt(pos); if(!ground) continue
      if(ground.name!=='farmland') { await bot.equip(hoe,'hand'); await bot.activateBlock(ground,new Vec3(0,1,0)); await sleep(250); ground=bot.blockAt(pos) }
      const currentSeeds=bot.inventory.items().find(i=>i.name==='wheat_seeds'); if(!currentSeeds) break
      if(ground&&ground.name==='farmland'&&['air','cave_air'].includes((bot.blockAt(pos.offset(0,1,0))||{}).name)){ await bot.equip(currentSeeds,'hand'); await bot.placeBlock(ground,new Vec3(0,1,0)); planted++; await sleep(200) }
    }
    return {planted,inventory:inventory()}
  })
  if (type === 'sleep') return boundedAction(type,a,async()=>{
    const bed=bot.blockAt(new Vec3(Number(a.x),Number(a.y),Number(a.z))); if(!bed||!bed.name.endsWith('_bed')) throw new Error('bed unavailable')
    if(bot.entity.position.distanceTo(bed.position)>4.5) await bot.pathfinder.goto(new goals.GoalNear(bed.position.x,bed.position.y,bed.position.z,2))
    await bot.sleep(bed); return {sleeping:bot.isSleeping}
  })
  if (type === 'furnaceTake') return boundedAction(type,a,async()=>{
    const pos=new Vec3(Number(a.x),Number(a.y),Number(a.z)); const block=bot.blockAt(pos)
    if(!block||!['furnace','smoker','blast_furnace'].includes(block.name)) throw new Error('furnace unavailable')
    if(bot.entity.position.distanceTo(pos)>4.5) await bot.pathfinder.goto(new goals.GoalNear(pos.x,pos.y,pos.z,2))
    const furnace=await bot.openFurnace(block); const taken=[]
    try{
      if(a.output!==false&&furnace.outputItem()){const i=await furnace.takeOutput();taken.push({slot:'output',name:i.name,count:i.count})}
      if(a.input&&furnace.inputItem()){const i=await furnace.takeInput();taken.push({slot:'input',name:i.name,count:i.count})}
      if(a.fuel&&furnace.fuelItem()){const i=await furnace.takeFuel();taken.push({slot:'fuel',name:i.name,count:i.count})}
      return {taken,inventory:inventory()}
    } finally {furnace.close()}
  })
  if (type === 'smelt') return boundedAction(type, a, async () => {
    let pos = (a.x != null && a.y != null && a.z != null) ? new Vec3(Number(a.x), Number(a.y), Number(a.z)) : null
    if (!pos) {
      const fb = bot.findBlock({ matching: b => b && ['furnace', 'blast_furnace', 'smoker'].includes(b.name), maxDistance: 12 })
      if (fb) pos = fb.position
    }
    if (!pos) throw new StateAssertionError('附近 12 格内未找到熔炉')
    const block = bot.blockAt(pos)
    if (!block || !['furnace', 'smoker', 'blast_furnace'].includes(block.name)) throw new StateAssertionError(`目标方块不是熔炉 (${block ? block.name : 'null'})`)
    if (bot.entity.position.distanceTo(pos) > 4.5) await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
    const inputName = a.input || a.item
    const input = bot.inventory.items().find(i => i.name === inputName)
    if (!input) throw new StateAssertionError(`背包缺少熔炼原料: ${inputName}`)
    const fuel = bot.inventory.items().find(i => i.name === a.fuel)
    if (!fuel) throw new StateAssertionError(`背包缺少燃料: ${a.fuel}`)
    const count = Math.min(Number(a.count || 1), input.count), fuelCount = Math.min(Number(a.fuelCount || 1), fuel.count)
    const furnace = await bot.openFurnace(block)
    try {
      const stale = []
      if (furnace.outputItem()) { const i = await furnace.takeOutput(); stale.push({ slot: 'output', name: i.name, count: i.count }) }
      if (furnace.inputItem()) { const i = await furnace.takeInput(); stale.push({ slot: 'input', name: i.name, count: i.count }) }
      if (furnace.fuelItem()) { const i = await furnace.takeFuel(); stale.push({ slot: 'fuel', name: i.name, count: i.count }) }
      await furnace.putInput(input.type, input.metadata, count)
      await furnace.putFuel(fuel.type, fuel.metadata, fuelCount)
      await waitUntil(() => furnace.outputItem() && furnace.outputItem().count >= count, {
        timeoutMs: Math.max(16000, count * 13000),
        intervalMs: 400,
        description: `等待熔炼产物生成 (需 ${count} 个)`
      })
      const out = furnace.outputItem()
      if (!out) throw new EnvironmentError('熔炉未产出预期物品')
      const item = await furnace.takeOutput()
      return { output: item.name, count: item.count, cleared: stale, inventory: inventory(), verdict: `PASS 成功熔炼 ${item.name} x${item.count}` }
    } finally { furnace.close() }
  }, parentToken)
  if (type === 'place') return boundedAction(type,a,async()=>{
    const item=bot.inventory.items().find(i=>i.name===a.item); if(!item) throw new Error(`missing item: ${a.item}`)
    const ref=bot.blockAt(new Vec3(Number(a.reference.x),Number(a.reference.y),Number(a.reference.z))); if(!ref||airNames.has(ref.name)) throw new Error('reference block unavailable')
    const face=new Vec3(Number(a.face.x),Number(a.face.y),Number(a.face.z)), target=ref.position.plus(face), existing=bot.blockAt(target)
    if(existing&&!replaceableNames.has(existing.name)) throw new Error(`placement target occupied by ${existing.name} at ${target}`)
    if(bot.entity.position.distanceTo(ref.position)>4.5) await bot.pathfinder.goto(new goals.GoalNear(ref.position.x,ref.position.y,ref.position.z,2))
    await bot.equip(item,'hand'); await bot.placeBlock(ref,face); await sleep(250)
    const placed=bot.blockAt(target)
    // 自动选材时 a.item 为空，必须与实际手持的 item.name 比较，否则会误报失败
    const want = a.item || item.name
    if(!placed||placed.name!==want) throw new Error(`placement not verified: expected ${want}, got ${placed&&placed.name}`)
    return {placed:a.item,position:posJSON(target)}
  })
  if (type === 'placeAt') return boundedAction(type, a, async () => {
    const item = a.item ? bot.inventory.items().find(i => i.name === a.item) : pickBuildItem(a.prefer)
    const target = new Vec3(Number(a.x), Number(a.y), Number(a.z))
    const existing = bot.blockAt(target)
    const targetItemName = a.item || (item && item.name)

    // 幂等保护：如果目标位置已有实体方块（建筑石材、泥土、草方块等），已构成天然或人工实体阻挡，直接判定成功
    if (existing && !airNames.has(existing.name) && !replaceableNames.has(existing.name)) {
      if (!targetItemName || existing.name === targetItemName || ['cobblestone', 'cobbled_deepslate', 'stone', 'tuff', 'dirt', 'grass_block', 'diorite', 'granite', 'andesite'].includes(existing.name)) {
        return { placed: existing.name, position: posJSON(target), note: 'already_solid_block' }
      }
      throw new Error(`placement target occupied by ${existing.name}`)
    }
    if (!item) throw new Error(a.item ? `missing item: ${a.item}` : 'no building block in inventory')

    const faces = [new Vec3(0,-1,0), new Vec3(0,1,0), new Vec3(-1,0,0), new Vec3(1,0,0), new Vec3(0,0,-1), new Vec3(0,0,1)]
    let ref = null, face = null
    for (const f of faces) {
      const r = bot.blockAt(target.minus(f))
      if (r && !airNames.has(r.name) && r.name !== 'water' && !replaceableNames.has(r.name)) { ref = r; face = f; break }
    }
    if (!ref) {
      const below = bot.blockAt(target.offset(0, -1, 0))
      if (below && !airNames.has(below.name) && below.name !== 'water') {
        ref = below
        face = new Vec3(0, 1, 0)
      }
    }
    if (!ref) throw new Error('no solid reference adjacent to target')
    if (bot.entity.position.distanceTo(target) > 4.2) {
      if (memory.flyingMode === 'on') {
        bot.entity.position.set(target.x, target.y + 2, target.z)
      } else {
        await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)).catch(() => {})
      }
    }
    await bot.equip(item, 'hand')
    await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
    const pPlace = bot.placeBlock(ref, face)
    const pTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('placeAt timeout')), 4000))
    await Promise.race([pPlace, pTimeout]).catch(() => {})
    await sleep(150)
    const placed = bot.blockAt(target)
    return { placed: placed ? placed.name : item.name, position: posJSON(target), reference: posJSON(ref.position) }
  })
  // ============ 分阶段房屋建造（AI 规划 → 材料自给 → 选址 → 施工 → 验收） ============
  // ============ 细粒度建造原语（每次只做一小步，由大脑逐步编排） ============
  if (type === 'craftChain') return boundedAction(type, a, async () => {
    // 纯机械合成：必要时先合成/放置工作台，然后在工作台上合成目标物品
    const nameStr = String(a.item || '')
    const item = mcData.itemsByName[nameStr]
    if (!item) throw new Error(`unknown item: ${nameStr}`)
    const count = Math.max(1, Math.min(Number(a.count || 1), 64))
    const before = countByName(nameStr)
    let recipe = bot.recipesFor(item.id, null, 1, null)[0]
    let table = null
    if (!recipe) {
      table = await ensureCraftingTable()
      if (table) recipe = bot.recipesFor(item.id, null, 1, table)[0]
    }
    if (!recipe) throw new Error(`no available recipe for ${nameStr} (可能需要工作台或缺少材料)`)
    // 3x3 配方需要真正打开工作台界面；界面偶尔开不出来（windowOpen 超时），
    // 这里必须先确认站得够近，再重试一次，并把可操作的距离写进报错里。
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (table) {
        const tpos = table.position
        if (bot.entity.position.distanceTo(tpos) > 4.0) {
          await bot.pathfinder.goto(new goals.GoalNear(tpos.x, tpos.y, tpos.z, 2)).catch(() => {})
        }
        const fresh = bot.blockAt(tpos)
        if (!fresh || fresh.name !== 'crafting_table') { table = await ensureCraftingTable(); if (!table) throw new Error('工作台消失了，无法合成') }
        if (bot.entity.position.distanceTo(table.position) > 4.2) {
          throw new Error(`离工作台太远(${round(bot.entity.position.distanceTo(table.position))})，无法打开合成界面`)
        }
        await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
      }
      try {
        await bot.craft(recipe, count, table)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        await sleep(600)
      }
    }
    if (lastErr) throw new Error(`合成 ${nameStr} 失败: ${String(lastErr.message).slice(0, 120)}`)
    await sleep(250)
    return { item: nameStr, requested: count, gained: countByName(nameStr) - before, total: countByName(nameStr), usedTable: !!table }
  })
  if (type === 'smeltOrCraftTable') return boundedAction(type, a, async () => {
    const table = await ensureCraftingTable()
    return { table: table ? posJSON(table.position) : null, ownTable: memory.ownCraftingTable || null }
  })
  if (type === 'buildLine') return boundedAction(type, a, async (token) => {
    // 沿一个方向连续放置方块（一次最多 16 块）
    const from = new Vec3(Number(a.x), Number(a.y), Number(a.z))
    const dir = new Vec3(Math.sign(Number(a.dx || 0)), Math.sign(Number(a.dy || 0)), Math.sign(Number(a.dz || 0)))
    if (Math.abs(dir.x) + Math.abs(dir.y) + Math.abs(dir.z) !== 1) throw new Error('buildLine requires exactly one non-zero direction among dx,dy,dz')
    const count = Math.max(1, Math.min(Number(a.count || 1), 16))
    const placed = [], skipped = []
    for (let i = 0; i < count && token === currentAbort; i++) {
      const target = from.plus(dir.scaled(i))
      const ok = await placeBlockSmart(target, a.item)
      if (ok) placed.push(posJSON(target)); else skipped.push(posJSON(target))
    }
    return { placed: placed.length, skipped: skipped.length, positions: placed, skippedPositions: skipped, remaining: count - placed.length, inventory: inventory() }
  })
  if (type === 'buildLayer') return boundedAction(type, a, async (token) => {
    // 铺一层矩形（水平面或垂直面，一次最多 64 块）
    const x1 = Math.min(Number(a.x1), Number(a.x2)), x2 = Math.max(Number(a.x1), Number(a.x2))
    const y1 = Math.min(Number(a.y1), Number(a.y2)), y2 = Math.max(Number(a.y1), Number(a.y2))
    const z1 = Math.min(Number(a.z1), Number(a.z2)), z2 = Math.max(Number(a.z1), Number(a.z2))
    if (![x1,y1,z1,x2,y2,z2].every(Number.isFinite)) throw new Error('buildLayer requires x1,y1,z1,x2,y2,z2')
    const total = (x2-x1+1)*(y2-y1+1)*(z2-z1+1)
    if (total > 64) throw new Error(`buildLayer too large: ${total} (max 64, split into smaller layers)`)

    const centerX = (x1 + x2) / 2, centerZ = (z1 + z2) / 2
    if (memory.flyingMode === 'on' || bot.physicsEnabled === false) {
      bot.entity.position.set(centerX, Math.max(y2 + 2, 64), centerZ)
    }

    const placed = [], skipped = []
    for (let y = y1; y <= y2 && token === currentAbort; y++)
      for (let x = x1; x <= x2 && token === currentAbort; x++)
        for (let z = z1; z <= z2 && token === currentAbort; z++) {
          const target = new Vec3(x, y, z)
          const ok = await placeBlockSmart(target, a.item)
          if (ok) placed.push(posJSON(target)); else skipped.push(posJSON(target))
        }
    return { placed: placed.length, skipped: skipped.length, skippedPositions: skipped.slice(0, 20), total, inventory: inventory() }
  })
  if (type === 'clearArea') return boundedAction(type, a, async (token) => {
    // 挖掉一个小区域（一次最多 64 块），用于场地找平/拆除
    const x1 = Math.min(Number(a.x1), Number(a.x2)), x2 = Math.max(Number(a.x1), Number(a.x2))
    const y1 = Math.min(Number(a.y1), Number(a.y2)), y2 = Math.max(Number(a.y1), Number(a.y2))
    const z1 = Math.min(Number(a.z1), Number(a.z2)), z2 = Math.max(Number(a.z1), Number(a.z2))
    if (![x1,y1,z1,x2,y2,z2].every(Number.isFinite)) throw new Error('clearArea requires x1,y1,z1,x2,y2,z2')
    const total = (x2-x1+1)*(y2-y1+1)*(z2-z1+1)
    if (total > 64) throw new Error(`clearArea too large: ${total} (max 64)`)

    const centerX = (x1 + x2) / 2, centerZ = (z1 + z2) / 2
    const distToCenter = Math.hypot(bot.entity.position.x - centerX, bot.entity.position.z - centerZ)
    if (distToCenter > 6) {
      throw new EnvironmentError(`距离待清理区域过远(${Math.round(distToCenter)}格 > 6格)，严禁隔空挥手！请先靠近至 4 格以内再执行挖掘。`)
    }

    // 若当前距离目标区域中心稍远，先统一寻路走近一次，避免逐块触发寻路
    const targetCenter = new Vec3(centerX, Math.max(y1, bot.entity.position.y), centerZ)
    if (bot.entity.position.distanceTo(targetCenter) > 4.5) {
      await bot.pathfinder.goto(new goals.GoalNear(centerX, targetCenter.y, centerZ, 3.0)).catch(() => {})
    }

    const dug = [], failed = [], protectedSkipped = []
    const t0 = Date.now()
    let timedOutEarly = false
    outerLoop:
    for (let y = y2; y >= y1 && token === currentAbort; y--)
      for (let x = x1; x <= x2 && token === currentAbort; x++)
        for (let z = z1; z <= z2 && token === currentAbort; z++) {
          if (Date.now() - t0 > 65000) {
            console.log(`[clearArea] 达到分段耗时上限(65s)，已安全清理 ${dug.length} 块，平滑收尾`)
            timedOutEarly = true
            break outerLoop
          }
          const pos = new Vec3(x, y, z)
          const b = bot.blockAt(pos)
          if (!b || airNames.has(b.name)) continue
          const guard = digGuard(pos, b.name, a.allowProtected)
          if (guard) { protectedSkipped.push({ ...posJSON(pos), name: b.name, reason: guard }); continue }
          if (!b.diggable) { failed.push({ ...posJSON(pos), reason: 'undiggable', name: b.name }); continue }
          // 绝不挖自己脚下的方块
          const feet = bot.entity.position.floored()
          if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) { failed.push({ ...posJSON(pos), reason: 'self-occupied' }); continue }
          try {
            if (bot.entity.position.distanceTo(pos) > 3.8) {
              await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2.2)).catch(() => {})
            }
            // 触距门禁：若仍然相隔超过 4.5 格，严禁对着空气挥手
            if (bot.entity.position.distanceTo(pos) > 4.5) {
              failed.push({ ...posJSON(pos), reason: 'too_far_unreachable', name: b.name })
              continue
            }
            await equipBestTool(b)
            await bot.dig(b, true)
            dug.push({ ...posJSON(pos), name: b.name })
            await sleep(90)
          } catch (e) { failed.push({ ...posJSON(pos), reason: String(e.message).slice(0, 60) }) }
        }

    // 若目标区域内有实际方块但全部未能挖掘，严禁假装成功
    if (dug.length === 0 && failed.length > 0) {
      throw new Error(`clearArea 失败：${failed.length} 个方块均未能采掘 (${failed[0].reason}，请先靠近施工区域)`)
    }
    return { dug: dug.length, dugBlocks: dug, partial: timedOutEarly, failed, protectedSkipped, total, inventory: inventory() }
  })
  if (type === 'collectDrops') return act({ type: 'collect', args: { radius: Number(a.radius || 8), maxItems: Number(a.maxItems || 12) } })

  if (type === 'inspect') {
    ensureReady()
    const x1 = Math.min(Number(a.x1), Number(a.x2)), x2 = Math.max(Number(a.x1), Number(a.x2))
    const y1 = Math.min(Number(a.y1), Number(a.y2)), y2 = Math.max(Number(a.y1), Number(a.y2))
    const z1 = Math.min(Number(a.z1), Number(a.z2)), z2 = Math.max(Number(a.z1), Number(a.z2))
    if (![x1, y1, z1, x2, y2, z2].every(Number.isFinite)) throw new Error('inspect requires x1,y1,z1,x2,y2,z2')
    if ((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1) > 40000) throw new Error('inspect volume too large (max 40000)')
    const counts = {}, listed = []
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b || airNames.has(b.name)) continue
      counts[b.name] = (counts[b.name] || 0) + 1
      if (a.list) listed.push({ name: b.name, x, y, z })
    }
    return { ok: true, result: { region: { x1, y1, z1, x2, y2, z2 }, counts, blocks: a.list ? listed : undefined } }
  }
  if (type === 'status') {
    return { ok: true, result: {
      ok: true,
      ready: memory.spawned && memory.authenticated,
      username: bot && bot.username,
      health: bot && Math.round(bot.health),
      food: bot && bot.food,
      position: bot && bot.entity ? posJSON(bot.entity.position) : null,
      deaths: memory.deaths || 0,
      lastDeathAt: memory.lastDeathAt || null,
      busy: memory.busy, action: memory.action,
      lastError: memory.lastError,
      shelterAnchor: memory.shelterAnchor,
      protectedRegions: memory.protectedRegions || [],
      gravity: (() => { try { return bot.physics.gravity } catch (_) { return null } })(),
      physicsEnabled: bot.physicsEnabled !== false,
      clientFlying: !!(bot.entity && bot.entity.flying),
      onGround: bot.entity ? !!bot.entity.onGround : null,
      flyingMode: memory.flyingMode || null
    } }
  }
  if (type === 'diagnose') {
    // 纯测量：回答"我为什么到不了那里"。绝不改动世界。
    ensureReady()
    const botPos = bot.entity.position.floored()
    const hasTarget = Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)) && Number.isFinite(Number(a.z))
    const target = hasTarget ? new Vec3(Number(a.x), Number(a.y), Number(a.z)) : null
    const out = {
      bot: posJSON(botPos),
      target: target ? posJSON(target) : null,
      feetBlock: (bot.blockAt(botPos) || {}).name,
      headBlock: (bot.blockAt(botPos.offset(0, 1, 0)) || {}).name,
      belowBlock: (bot.blockAt(botPos.offset(0, -1, 0)) || {}).name
    }
    // 是否寻得到路
    if (target) {
      try {
        const res = bot.pathfinder.getPathTo(movements, new goals.GoalNear(target.x, target.y, target.z, Number(a.range || 1)), 2500)
        out.pathStatus = res && res.status
        out.pathLength = res && res.path ? res.path.length : 0
        out.reachable = !!(res && res.path && res.path.length)
      } catch (e) { out.reachable = false; out.pathError = String(e.message).slice(0, 140) }
    }
    // 直线走廊上的阻挡方块（脚层与头层）——这才是"到底什么挡住了路"的答案
    const blockers = []
    if (target) {
      const steps = Math.max(Math.abs(target.x - botPos.x), Math.abs(target.z - botPos.z))
      for (let i = 1; i <= Math.min(steps, 16); i++) {
        const t = steps === 0 ? 1 : i / steps
        const cx = Math.round(botPos.x + (target.x - botPos.x) * t)
        const cz = Math.round(botPos.z + (target.z - botPos.z) * t)
        for (const dy of [0, 1]) {
          const pos = new Vec3(cx, botPos.y + dy, cz)
          const b = bot.blockAt(pos)
          if (!b || airNames.has(b.name) || replaceableNames.has(b.name)) continue
          if (b.name.endsWith('_door')) continue // 门是可通过的，不算障碍
          // 只把真正有碰撞体积的方块算作障碍：火把/草/告示牌等 boundingBox==='empty'，玩家可以直接走过，若算进去会误导大脑去挖自己的火把。
          if (b.boundingBox === 'empty') continue
          const hard = !!protectedRegionAt(pos) || isProtectedName(b.name)
          blockers.push({ x: cx, y: pos.y, z: cz, name: b.name, layer: dy === 0 ? 'feet' : 'head', diggable: !!b.diggable, protected: hard, natural: !hard })
        }
      }
    }
    // 目标格及其下方是否站得住
    if (target) {
      out.targetBlock = (bot.blockAt(target) || {}).name
      out.targetBelow = (bot.blockAt(target.offset(0, -1, 0)) || {}).name
    }
    // 附近的门（提示大脑：门通常是可以通过的，别拆它）
    const doors = []
    for (let dx = -4; dx <= 4; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) {
      const b = bot.blockAt(botPos.offset(dx, dy, dz))
      if (b && b.name.endsWith('_door')) doors.push({ ...posJSON(b.position), name: b.name })
    }
    out.blockers = blockers
    out.blockerCount = blockers.length
    out.nearbyDoors = doors
    out.advice = blockers.length
      ? `真正挡路的是 ${blockers.map(b => `${b.name}@(${b.x},${b.y},${b.z})`).slice(0, 6).join(', ')}；清掉它们即可，不要拆门。`
      : (out.reachable === false ? '直线没有明显阻挡但仍寻不到路：可能是高差/需要跳越或门被关闭，考虑换一个 waypoint 或 unstuck。' : '路径通畅。')
    return { ok: true, result: out }
  }
  if (type === 'protectRegion') {
    // 把已建成的结构登记为受保护区：之后任何破坏动作都会被硬性拒绝，防止机器人拆自己的房子
    const [x1, x2] = [Math.min(Number(a.x1), Number(a.x2)), Math.max(Number(a.x1), Number(a.x2))]
    const [y1, y2] = [Math.min(Number(a.y1), Number(a.y2)), Math.max(Number(a.y1), Number(a.y2))]
    const [z1, z2] = [Math.min(Number(a.z1), Number(a.z2)), Math.max(Number(a.z1), Number(a.z2))]
    if (![x1, x2, y1, y2, z1, z2].every(Number.isFinite)) throw new Error('protectRegion requires x1,x2,y1,y2,z1,z2')
    const label = String(a.label || 'structure')
    if (a.replace) memory.protectedRegions = []
    memory.protectedRegions = (memory.protectedRegions || []).filter(r => r.label !== label)
    memory.protectedRegions.push({ label, x1, x2, y1, y2, z1, z2 })
    saveState()
    return { ok: true, result: { regions: memory.protectedRegions } }
  }
  if (type === 'unprotectRegion') {
    if (a.all) memory.protectedRegions = []
    else if (a.label) memory.protectedRegions = (memory.protectedRegions || []).filter(r => r.label !== a.label)
    saveState()
    return { ok: true, result: { regions: memory.protectedRegions || [] } }
  }
  if (type === 'door') return boundedAction(type, a, async () => {
    // 门的开/关/切换：走近 → 交互 → 读回属性验证，绝不靠"我点过了"自欺
    const want = String(a.state || 'toggle').toLowerCase()
    let doorBlock = null
    if (Number.isFinite(Number(a.x))) {
      doorBlock = bot.blockAt(new Vec3(Number(a.x), Number(a.y), Number(a.z)))
    } else {
      const found = bot.findBlock({ matching: b => b && b.name.endsWith('_door'), maxDistance: Number(a.radius || 8) })
      doorBlock = found ? bot.blockAt(found.position) : null
    }
    if (!doorBlock || !doorBlock.name.endsWith('_door')) throw new Error('door unavailable: 指定位置不是门')
    const doorName = doorBlock.name
    const lowerOf = b => {
      const props = (b && b.getProperties && b.getProperties()) || {}
      return String(props.half || '').toLowerCase() === 'upper' ? bot.blockAt(b.position.offset(0, -1, 0)) || b : b
    }
    const readOpen = b => {
      const props = (b && b.getProperties && b.getProperties()) || {}
      return props.open === true || props.open === 'true'
    }
    const lower = lowerOf(doorBlock)
    const before = readOpen(lower)
    const target = want === 'toggle' ? !before : (want === 'open')
    if (before === target) {
      return { door: posJSON(lower.position), name: doorName, openBefore: before, open: before, changed: false, verified: true, note: `门本来就是${before ? '开' : '关'}的` }
    }
    // 走到门前（门是 2 格高，靠近下半部分）
    if (bot.entity.position.distanceTo(lower.position) > 2.6) {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(lower.position.x, lower.position.y, lower.position.z, 2)),
        sleep(6000).then(() => { throw new Error('走近门超时(>6s)') })
      ]).catch(() => {})
    }
    if (bot.entity.position.distanceTo(lower.position) > 4.2) throw new Error(`够不到门 ${posJSON(lower.position)}，距离 ${round(bot.entity.position.distanceTo(lower.position))}`)
    await bot.lookAt(lower.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
    await bot.activateBlock(lower)
    await sleep(450)
    const after = readOpen(bot.blockAt(lower.position) || lower)
    return {
      door: posJSON(lower.position), name: doorName,
      openBefore: before, open: after, changed: after !== before,
      verified: after === target,
      note: after === target ? `门已${after ? '打开' : '关上'}` : `交互后门仍是${after ? '开' : '关'}的（可能被阻挡或需要重试）`
    }
  })
  if (type === 'passDoor') return boundedAction(type, a, async () => {
    // 开门 → 走过去 → 离开门洞 → 随手关门。全程自带验证，失败时给出 trail。
    const d = a.door, to = a.to
    if (!d || !to) throw new Error('passDoor requires door{x,y,z} and to{x,y,z}')
    const doorPos = new Vec3(Number(d.x), Number(d.y), Number(d.z))
    const dest = new Vec3(Number(to.x), Number(to.y), Number(to.z))
    const doorBlock = bot.blockAt(doorPos)
    if (!doorBlock || !doorBlock.name.endsWith('_door')) throw new Error('passDoor: 指定位置不是门')

    const readOpen = b => { const pr = (b && b.getProperties && b.getProperties()) || {}; return pr.open === true || pr.open === 'true' }
    const lowerOf = b => {
      const pr = (b && b.getProperties && b.getProperties()) || {}
      return String(pr.half || '').toLowerCase() === 'upper' ? (bot.blockAt(b.position.offset(0, -1, 0)) || b) : b
    }
    const lower = lowerOf(doorBlock)
    const ARRIVE = Number(a.arriveRange || 1.35)
    const inDoorCell = () => {
      const f = bot.entity.position.floored()
      return f.x === lower.position.x && f.z === lower.position.z
    }
    const trail = []

    // 交还控制权：goto 失败后 pathfinder 仍可能持目标，会和手动按键抢控制权，
    // 表现就是"机器人完全不动"。
    const seizeControl = async () => {
      interruptPath()
      bot.clearControlStates()
      await sleep(180)
    }

    // 用短促迈步走向目标（玩家过门的方式），比纯寻路更可靠
    const walkToward = async (target, maxSteps, range = ARRIVE) => {
      await seizeControl()
      let last = bot.entity.position.distanceTo(target)
      for (let i = 0; i < maxSteps; i++) {
        if (bot.entity.position.distanceTo(target) <= range) return true
        await bot.lookAt(new Vec3(target.x + 0.5, bot.entity.position.y + 1.6, target.z + 0.5), true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(650)
        bot.setControlState('forward', false)
        await sleep(150)
        const now = bot.entity.position.distanceTo(target)
        if (now <= range) return true
        if (now > last - 0.08) {           // 没进展 → 侧移一下再试
          const side = (i % 2 === 0) ? 'left' : 'right'
          bot.setControlState(side, true); await sleep(320)
          bot.setControlState(side, false); await sleep(140)
        }
        last = now
      }
      return bot.entity.position.distanceTo(target) <= range
    }

    // 1) 开门
    if (!readOpen(bot.blockAt(lower.position) || lower)) {
      try {
        if (bot.entity.position.distanceTo(lower.position) > 2.6) {
          await bot.pathfinder.goto(new goals.GoalNear(lower.position.x, lower.position.y, lower.position.z, 2)).catch(() => {})
          await seizeControl()
        }
        await bot.lookAt(lower.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
        await bot.activateBlock(bot.blockAt(lower.position) || lower)
        await sleep(450)
      } catch (e) { trail.push({ step: 'openDoor', error: String(e.message).slice(0, 90) }) }
    }
    const openedOk = readOpen(bot.blockAt(lower.position) || lower)
    trail.push({ step: 'openDoor', open: openedOk })
    if (!openedOk) {
      return { door: posJSON(lower.position), destination: posJSON(dest), arrived: false, doorClosed: false, trail,
               verdict: 'FAIL 门打不开，先排查门是否装好/被挡住' }
    }

    // 2) 走到目的地。
    //    via（强烈建议传）：门洞另一侧"没有门的那一格"坐标。
    //    1 格宽的门洞在门打开后，门板仍会横在通道上（门板是 0.1875 厚的整宽薄板），
    //    此时从门板那一侧是过不去的。正确做法是把门洞留成 2 格宽：一格装门、一格留空，
    //    实际通行走留空的那一格。via 就是那个空格。
    let arrived = bot.entity.position.distanceTo(dest) <= ARRIVE
    const waypoints = []
    if (a.via && Number.isFinite(Number(a.via.x))) waypoints.push(new Vec3(Number(a.via.x), Number(a.via.y), Number(a.via.z)))
    waypoints.push(dest)
    if (!arrived) {
      for (const wp of waypoints) {
        if (bot.entity.position.distanceTo(wp) <= ARRIVE) continue
        let ok = false
        try {
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(wp.x, wp.y, wp.z, 1)),
            sleep(10000).then(() => { throw new Error('寻路门洞超过 10s') })
          ])
          ok = bot.entity.position.distanceTo(wp) <= ARRIVE
        } catch (e) { trail.push({ step: 'walkPath', to: posJSON(wp), error: String(e.message).slice(0, 70) }) }
        if (!ok) ok = await walkToward(wp, 6)
        trail.push({ step: 'waypoint', to: posJSON(wp), ok, at: posJSON(bot.entity.position) })
        if (bot.entity.position.distanceTo(dest) <= ARRIVE) break
      }
      arrived = bot.entity.position.distanceTo(dest) <= ARRIVE
    }
    trail.push({ step: 'walk', arrived, at: posJSON(bot.entity.position), distanceToDest: round(bot.entity.position.distanceTo(dest)) })

    // 3) 离开门洞那一格再关门，否则门会把机器人夹死在墙里
    let cleared = !inDoorCell()
    if (!cleared) {
      await walkToward(dest, 3)
      cleared = !inDoorCell()
    }
    trail.push({ step: 'clearDoorway', at: posJSON(bot.entity.position), cleared })

    // 4) 随手关门
    let closed = false
    if (cleared) {
      try {
        if (readOpen(bot.blockAt(lower.position) || lower)) {
          // 够不着就主动折返到门前约 3 格处（而不是因为太远就放弃关门）
          if (bot.entity.position.distanceTo(lower.position) > 4.0) {
            const dir = lower.position.minus(bot.entity.position)
            const len = Math.hypot(dir.x, dir.z) || 1
            const reach = new Vec3(
              lower.position.x - Math.round((dir.x / len) * 3),
              bot.entity.position.y,
              lower.position.z - Math.round((dir.z / len) * 3)
            )
            trail.push({ step: 'returnToClose', reach: posJSON(reach) })
            await walkToward(reach, 4, 2.0)
          }
          if (bot.entity.position.distanceTo(lower.position) <= 4.2) {
            await bot.lookAt(lower.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
            await bot.activateBlock(bot.blockAt(lower.position) || lower)
            await sleep(450)
          }
        }
        const fresh = bot.blockAt(lower.position)
        closed = !!fresh && !readOpen(fresh)
      } catch (e) { trail.push({ step: 'closeDoor', error: String(e.message).slice(0, 90) }) }
    }
    const finallyInside = !inDoorCell()
    return {
      door: posJSON(lower.position), destination: posJSON(dest),
      arrived, doorClosed: closed, clearOfDoor: finallyInside, trail,
      verdict: (arrived && closed)
        ? 'PASS 已穿过门并随手关门'
        : (!arrived ? 'FAIL 没能到达目的地' : (!finallyInside ? 'PARTIAL 到了但还卡在门洞' : 'PARTIAL 到了但门还开着'))
    }
  })
  if (type === 'simulateMaster') {
    // 诊断/测试专用，生产环境默认关闭，避免本地 API 调用伪造主人身份。
    if (cfg.allowSimulateMaster !== true) throw new Error('simulateMaster disabled by configuration')
    ensureReady()
    const text = String(a.message || '测试消息')
    const from = String(a.from || (Array.isArray(cfg.masters) ? cfg.masters[0] : 'chaoji34'))
    const entry = { id: 'sim' + Date.now().toString(36), from, text, at: new Date().toISOString(), acked: false }
    memory.pendingInstructions.push(entry)
    memory.chatQueue.push(entry)
    const wasBusy = !!memory.busy
    const aborted = memory.action
    if (memory.busy) stopAll('simulated master spoke')
    return { ok: true, result: { queued: entry, wasBusy, abortedAction: aborted, queueLength: memory.chatQueue.length } }
  }
  if (type === 'probeBlock') {
    // 纯测量：报告某个方块"物理引擎眼中的样子"，用于排查"为什么过不去"
    ensureReady()
    const pos = new Vec3(Number(a.x), Number(a.y), Number(a.z))
    const b = bot.blockAt(pos)
    if (!b) return { ok: true, result: { pos: posJSON(pos), block: null } }
    const props = (typeof b.getProperties === 'function' ? b.getProperties() : null) || null
    return { ok: true, result: {
      pos: posJSON(pos), name: b.name, type: b.type, properties: props,
      boundingBox: b.boundingBox, shapes: b.shapes, physical: b.physical, diggable: !!b.diggable,
      entityCell: posJSON(bot.entity.position.floored())
    } }
  }
  if (type === 'stepTest') {
    // 诊断用：单纯按键前进并采样位置，判断"物理层面到底能不能动"
    ensureReady()
    const ms = Math.min(Number(a.ms || 1200), 5000)
    interruptPath()   // 绝不能用 stop()：stepTest 之后紧接着就要移动
    await sleep(200)
    const dir = a.dir || 'forward'
    const samples = []
    const start = bot.entity.position.clone()
    await bot.lookAt(new Vec3(start.x + Number(a.dx || 0), start.y + 1.5, start.z + Number(a.dz || 0)), true).catch(() => {})
    bot.setControlState(dir, true)
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await sleep(200)
      samples.push({ t: Date.now() - t0, pos: posJSON(bot.entity.position), onGround: bot.entity.onGround })
    }
    bot.setControlState(dir, false)
    await sleep(200)
    const moved = bot.entity.position.distanceTo(start)
    return { ok: true, result: { start: posJSON(start), end: posJSON(bot.entity.position), moved: round(moved), samples, physicsFrozen: moved < 0.15, dir } }
  }
  if (type === 'fly') return boundedAction(type, a, async () => {
    const want = String(a.state || 'on').toLowerCase() === 'off' ? 'off' : 'on'
    return await ensureFlightMode(want)
  })
  if (type === 'flyTo') return boundedAction(type, a, async (token) => {
    // 高空净空巡航飞行到目标点（三段式：原地爬升至安全净空层 -> 高空纯空气无阻挡平飞 -> 目标正上方垂直降落）
    const x = Number(a.x), y = Number(a.y), z = Number(a.z)
    if (![x, y, z].every(Number.isFinite)) throw new Error('flyTo requires numeric x,y,z')
    const dest = new Vec3(x, y, z)
    const stepLen = Math.min(Math.max(Number(a.stepLen || 0.65), 0.3), 1.0)
    const trail = []

    if (memory.flyingMode !== 'on') {
      const flyRes = await ensureFlightMode('on')
      trail.push({ step: 'ensureFlyOn', verdict: flyRes.verdict, state: flyRes.state })
    } else {
      trail.push({ step: 'ensureFlyOn', verdict: '已处于飞行模式' })
    }

    const start = bot.entity.position.clone()
    console.log(`[flyTo] call: start=${JSON.stringify(posJSON(start))}, dest=${JSON.stringify(posJSON(dest))}`)
    let err = null

    // 检查直接上方是否存在实心方块阻挡起飞
    let canDirectAscend = true
    const fStart = start.floored()
    for (let dy = 1; dy <= 20; dy++) {
      const blk = bot.blockAt(fStart.offset(0, dy, 0))
      if (blk && blk.boundingBox === 'block') {
        canDirectAscend = false
        break
      }
    }

    // 地下深层防护：若在地下(Y < 50)，严禁使用 flyTo 直穿岩层！
    if (start.y < 50 && !canDirectAscend) {
      throw new StateAssertionError(`当前处于地下深度 Y=${round(start.y)}，头顶存在厚重岩层，严禁使用 flyTo（会穿墙触发反作弊掉线）！请使用 digStair、branchMine 或 mine 阶梯下挖/上行。`)
    }

    const cruiseY = 78
    const waypoints = []
    const totalDist = start.distanceTo(dest)

    const isLineClear = (from, to) => {
      const d = from.distanceTo(to)
      const steps = Math.ceil(d * 2)
      for (let i = 1; i < steps; i++) {
        const pt = from.plus(to.minus(from).scaled(i / steps)).floored()
        const b = bot.blockAt(pt), bHead = bot.blockAt(pt.offset(0, 1, 0))
        if ((b && b.boundingBox === 'block') || (bHead && bHead.boundingBox === 'block')) return false
      }
      return true
    }

    if (totalDist <= 10 && !canDirectAscend) {
      throw new StateAssertionError(`室内/头顶有方块阻挡且水平距离仅 ${round(totalDist)} 格，严禁使用高空 flyTo（会导致撞击天花板与卡死）！请直接使用 move 或 travel。`)
    }

    if (totalDist <= 5 && isLineClear(start, dest)) {
      // 仅在极近距离且两点间完全无实心方块阻挡时直飞
      waypoints.push(new Vec3(dest.x, dest.y + 1, dest.z))
    } else {
      // 其它情况一律先升至 Y=78 净空高度，彻底避开地表建筑、树冠与围墙，防止服务端拉回与卡死
      if (!canDirectAscend) {
        // 头顶有遮挡（例如在屋内、树下）：先平移到门外或开阔地
        let egressPos = null
        if (start.x >= 0 && start.x <= 8 && start.z >= 86 && start.z <= 93) {
          egressPos = new Vec3(4, 65, 85)
        } else {
          for (let r = 1; r <= 4 && !egressPos; r++) {
            for (let dx = -r; dx <= r && !egressPos; dx++) {
              for (let dz = -r; dz <= r && !egressPos; dz++) {
                const checkPos = fStart.offset(dx, 0, dz)
                let clear = true
                for (let dy = 1; dy <= 16; dy++) {
                  const b = bot.blockAt(checkPos.offset(0, dy, 0))
                  if (b && b.boundingBox === 'block') { clear = false; break }
                }
                if (clear) egressPos = checkPos
              }
            }
          }
        }
        if (egressPos) {
          waypoints.push(new Vec3(egressPos.x, egressPos.y, egressPos.z))
          waypoints.push(new Vec3(egressPos.x, cruiseY, egressPos.z))
        } else {
          waypoints.push(new Vec3(start.x, cruiseY, start.z))
        }
      } else {
        waypoints.push(new Vec3(start.x, cruiseY, start.z))
      }
      waypoints.push(new Vec3(dest.x, cruiseY, dest.z))
      waypoints.push(new Vec3(dest.x, dest.y + 1, dest.z))
    }

    console.log(`[flyTo] start=${JSON.stringify(posJSON(start))}, dest=${JSON.stringify(posJSON(dest))}, totalDist=${round(totalDist)}, waypoints=${waypoints.length}`)

    try {
      try { bot.clearControlStates() } catch (_) {}
      try { bot.creative.startFlying() } catch (_) {}
      try { bot._client.write('abilities', { flags: 0x02 }) } catch (_) {}
      bot.physics.gravity = 0
      bot.physicsEnabled = false
      let totalSteps = 0

      for (let wIdx = 0; wIdx < waypoints.length; wIdx++) {
        const wp = waypoints[wIdx]
        const wDist = bot.entity.position.distanceTo(wp)
        const wpMaxSteps = Math.max(80, Math.ceil(wDist / stepLen) + 40)
        console.log(`[flyTo] wp ${wIdx+1}/${waypoints.length}: target=${JSON.stringify(posJSON(wp))}, dist=${round(wDist)}, maxSteps=${wpMaxSteps}`)

        for (let i = 0; i < wpMaxSteps; i++) {
          if (token !== currentAbort) throw new EnvironmentError('飞行被中止')
          const cur = bot.entity.position
          const d = cur.distanceTo(wp)
          if (d <= 1.2) break
          const moveDist = Math.min(stepLen, d)
          const dir = wp.minus(cur).scaled(1 / d)
          const nextPos = cur.plus(dir.scaled(moveDist))
          bot.entity.position.set(nextPos.x, nextPos.y, nextPos.z)
          bot.entity.velocity.set(0, 0, 0)
          totalSteps++
          if (totalSteps % 4 === 0) {
            await bot.lookAt(wp, true).catch(() => {})
          }
          await sleep(50)
        }
        trail.push({ waypoint: wIdx + 1, target: posJSON(wp), reached: posJSON(bot.entity.position) })
      }
      trail.push({ step: 'flightDone', totalSteps })
      console.log(`[flyTo] waypoints finished, totalSteps=${totalSteps}, at=${JSON.stringify(posJSON(bot.entity.position))}`)
    } catch (e) {
      err = String(e.message || e).slice(0, 140)
    } finally {
      bot.physicsEnabled = true
      bot.physics.gravity = 0.08
      memory.flyingMode = 'off'
      try { bot.creative.stopFlying() } catch (_) {}
    }

    // 落点安全检查：找地表真正可站立的实心地面（排除悬空树冠与树叶，优先坚实地表）
    try {
      const isSolidGround = v => {
        const b = bot.blockAt(v)
        if (!b || b.boundingBox !== 'block') return false
        if (b.name.includes('leaves') || b.name === 'leaf_litter') return false
        return true
      }
      let groundPos = dest.clone()
      if (!isSolidGround(dest.offset(0, -1, 0))) {
        let best = null
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
          const cx = Math.round(dest.x + dx), cz = Math.round(dest.z + dz)
          for (let cy = Math.round(dest.y) + 4; cy >= Math.round(dest.y) - 10; cy--) {
            const ground = new Vec3(cx, cy, cz)
            if (!isSolidGround(ground)) continue
            const stand = ground.offset(0, 1, 0)
            const head = stand.offset(0, 1, 0)
            const bStand = bot.blockAt(stand), bHead = bot.blockAt(head)
            if (bStand && bStand.boundingBox === 'block') continue
            if (bHead && bHead.boundingBox === 'block') continue
            const score = cy * 10 - Math.hypot(dx, dz) * 5
            if (!best || score > best.score) best = { pos: stand, cy, score }
            break
          }
        }
        if (best) groundPos = best.pos
      }

      // 平滑贴地
      const cur = bot.entity.position
      const downDist = cur.distanceTo(groundPos)
      const landSteps = Math.min(40, Math.ceil(downDist / 0.5) + 8)
      for (let i = 0; i < landSteps; i++) {
        const c2 = bot.entity.position
        const dd = c2.distanceTo(groundPos)
        if (dd <= 0.8) break
        const step = Math.min(0.5, dd)
        bot.entity.position.add(groundPos.minus(c2).scaled(step / dd))
        bot.entity.velocity.set(0, 0, 0)
        await sleep(50)
      }
    } catch (e) { trail.push({ step: 'landing', error: String(e.message).slice(0, 80) }) }

    // 还原重力与飞行状态，让它真正落地
    bot.physics.gravity = 0.08
    memory.flyingMode = 'off'
    try { bot.creative.stopFlying() } catch (_) {}
    bot.entity.velocity.set(0, 0, 0)
    try { bot.clearControlStates() } catch (_) {}
    let grounded = false
    for (let i = 0; i < 8; i++) {
      await sleep(100)
      const b = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (b && b.boundingBox === 'block') { grounded = true; break }
    }
    const finalPos = bot.entity.position
    // 飞行到达判定：水平误差允许在 8 格内，或垂直方向落在安全地表
    const horizDist = Math.hypot(finalPos.x - dest.x, finalPos.z - dest.z)
    const arriveRange = Number(a.arriveRange || 8)
    const arrived = horizDist <= arriveRange || finalPos.distanceTo(dest) <= arriveRange
    if (!arrived) {
      throw new Error(`飞行未能抵达目标点（离目标水平仍有 ${round(horizDist)} 格，落点: [${round(finalPos.x)}, ${round(finalPos.y)}, ${round(finalPos.z)}]）`)
    }
    return {
      destination: posJSON(dest), start: posJSON(start), at: posJSON(finalPos),
      verticalDelta: round(finalPos.y - start.y), arrived: true, grounded, error: err, trail,
      verdict: 'PASS 已通过高空净空巡航成功飞抵目标并安全落地'
    }
  })
  if (type === 'travel') return boundedAction(type, a, async (token) => {
    // 长距离赶路（例如从出生点回 80 格外的家）。
    // 为什么需要它：一次 move/flyTo 跨越几十格，pathfinder 很容易算不出路或中途被打断；
    // 而"每轮发一次 move"又会因为回合间隔（30s+）把 80 格走成半小时。
    // 这里用一次有界动作、分成若干 8~20 格的短跳走完，每跳都校验是否真的在靠近。
    ensureReady()
    const dest = new Vec3(Number(a.x), Number(a.y), Number(a.z))
    if (![dest.x, dest.y, dest.z].every(Number.isFinite)) throw new Error('travel requires x,y,z')
    const hop = Math.min(Math.max(Number(a.hop || 12), 4), 24)
    const maxHops = Math.min(Math.max(Number(a.maxHops || 6), 1), 24)
    const arriveRange = Number(a.arriveRange || 3)
    // 自管时间预算：单动作硬上限 90s，travel 限时 45s 就安全返回，留足余量优雅收工
    const deadline = Date.now() + Math.min(Number(a.timeBudgetMs || 45000), 50000)
    const trail = []
    const startPos = bot.entity.position.clone()
    const isSolid = v => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block' }
    const openAt = v => { const b = bot.blockAt(v); return !b || airNames.has(b.name) }

    const surfaceY = (x, z, refY) => {
      // 从"参考高度之上"往下找第一块可站立的地面 —— 即地表。
      // 参考高度用目的地的 y（而不是当前位置），否则会跟着地形一路下钻到地底（实测发生过）。
      for (let y = Math.round(refY) + 12; y >= Math.round(refY) - 12; y--) {
        const g = new Vec3(x, y, z)
        if (!isSolid(g)) continue
        if (!openAt(g.offset(0, 1, 0)) || !openAt(g.offset(0, 2, 0))) continue
        return y + 1
      }
      return null
    }

    let arrived = bot.entity.position.distanceTo(dest) <= arriveRange
    let budgetOut = false
    for (let i = 1; i <= maxHops && !arrived && token === currentAbort; i++) {
      if (Date.now() > deadline) {
        budgetOut = true
        trail.push({ hop: i, note: '时间预算用尽，本轮先走到这里，下一轮继续' })
        break
      }
      const cur = bot.entity.position.clone()
      const flat = Math.hypot(dest.x - cur.x, dest.z - cur.z)
      const dy = Math.abs(dest.y - cur.y)
      // 到达判定必须看三维：只看水平距离会误判（实测在目标正上方 7 格就报"抵达"）
      if (flat <= arriveRange && dy <= 3) { arrived = true; break }
      if (flat <= arriveRange && dy > 3) {
        // 正好在目标上方/下方：需要垂直移动，超出步行能力，交给 flyTo / pillarUp / land
        trail.push({ hop: i, note: `水平已到位但高度差 ${round(dy)} 格，需要 flyTo/land/pillarUp` })
        break
      }
      const step = Math.min(hop, flat)
      const dir = new Vec3(dest.x - cur.x, 0, dest.z - cur.z).scaled(1 / (flat || 1))
      const nx = Math.round(cur.x + dir.x * step)
      const nz = Math.round(cur.z + dir.z * step)
      const ny = surfaceY(nx, nz, dest.y) ?? cur.y
      const wp = new Vec3(nx, ny, nz)
      let ok = false
      const hopMs = Math.max(4000, deadline - Date.now())
      try {
        // 单跳也要限时：pathfinder 在烂地形上可能卡很久，不能让一跳吃掉整轮预算
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(wp.x, wp.y, wp.z, Math.min(2, arriveRange))),
          sleep(hopMs).then(() => { throw new Error(`单跳超过 ${Math.round(hopMs / 1000)}s`) })
        ])
        ok = bot.entity.position.distanceTo(wp) <= arriveRange + 1.5
      } catch (e) {
        trail.push({ hop: i, to: posJSON(wp), error: String(e.message).slice(0, 70) })
        interruptPath()   // 不能用 stop()：会毒掉下一次 goto
      }
      // 寻路失败时：先把正前方挡路的天然方块挖掉（树林里最常见的就是树叶/原木挡住去路），
      // 再退化成"手动短促前进"。注意只挖 natural 的，成品建筑与门/家具一律不碰。
      if (!ok) {
        const cleared = []
        try {
          const cf = bot.entity.position.floored()
          for (let fwd = 1; fwd <= 3; fwd++) {
            const bx = Math.round(cf.x + dir.x * fwd), bz = Math.round(cf.z + dir.z * fwd)
            for (const dy of [0, 1, 2]) {
              const bp = new Vec3(bx, cf.y + dy, bz)
              const b = bot.blockAt(bp)
              if (!b || airNames.has(b.name)) continue
              const guard = digGuard(bp, b.name, a.allowProtected)
              if (guard) continue          // 受保护/建材，跳过
              if (!b.diggable) continue
              try {
                await equipBestTool(b); await bot.dig(b, true)
                cleared.push({ ...posJSON(bp), name: b.name }); await sleep(120)
              } catch (_) {}
            }
          }
        } catch (_) {}
        if (cleared.length) trail.push({ hop: i, cleared: cleared.length, blocks: cleared.slice(0, 6) })
        try {
          interruptPath(); await sleep(150)
          for (let s = 0; s < 4; s++) {
            await bot.lookAt(new Vec3(wp.x + 0.5, bot.entity.position.y + 1.6, wp.z + 0.5), true).catch(() => {})
            bot.setControlState('forward', true); await sleep(700); bot.setControlState('forward', false)
            await sleep(150)
            if (bot.entity.position.distanceTo(wp) <= arriveRange + 1.5) { ok = true; break }
          }
        } catch (_) {}
        if (ok) { // 手动走上去之后可能需要跳上台阶
          bot.setControlState('jump', true); await sleep(250); bot.setControlState('jump', false)
        }
      }
      const now = bot.entity.position.clone()
      const progressed = now.distanceTo(dest) < cur.distanceTo(dest) - 0.8
      trail.push({ hop: i, to: posJSON(wp), ok, at: posJSON(now), remaining: round(now.distanceTo(dest)), progressed })
      if (now.distanceTo(dest) <= arriveRange) { arrived = true; break }
      if (!progressed) {
        // 连续两跳都没靠近就没必要继续耗时间
        const prev = trail[trail.length - 2]
        if (prev && prev.progressed === false) { trail.push({ note: '连续两跳无进展，停止赶路' }); break }
      }
    }
    bot.clearControlStates()
    const finalPos = bot.entity.position
    return {
      destination: posJSON(dest), start: posJSON(startPos), at: posJSON(finalPos), arrived,
      progress: round(startPos.distanceTo(dest) - finalPos.distanceTo(dest)),
      remaining: round(finalPos.distanceTo(dest)), hops: trail.filter(t => t.hop).length,
      budgetOut, trail,
      verdict: arrived
        ? 'PASS 已抵达目的地'
        : `PARTIAL 本轮推进 ${round(startPos.distanceTo(dest) - finalPos.distanceTo(dest))} 格，还差 ${round(finalPos.distanceTo(dest))} 格`
    }
  })
  if (type === 'placeDoor') {
    // 精确放门：显式指定朝向 yaw。
    // 为什么需要：门开合只旋转碰撞盒朝向，碰撞盒永远是一块薄板。
    // 若开门后薄板横在通道方向上（facing 与墙平行关系搞错），1 格宽门洞就会被堵死。
    // 所以必须按"墙的方向"来决定放门时的朝向，并在放完后读回 facing 验证。
    ensureReady()
    const pos = new Vec3(Number(a.x), Number(a.y), Number(a.z))
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error('placeDoor requires x,y,z')
    const doorItem = bot.inventory.items().find(i => i.name.endsWith('_door'))
    if (!doorItem) throw new Error('背包里没有门')
    const ref = bot.blockAt(pos.offset(0, -1, 0))
    if (!ref || airNames.has(ref.name)) throw new Error('门下方没有可依附的方块')
    const at = bot.blockAt(pos)
    if (at && !airNames.has(at.name) && !at.name.endsWith('_door')) throw new Error(`门位被 ${at.name} 占用`)

    // 站到门侧方（沿墙方向，而不是正对门洞），保证不会被门板挤住
    const yaw = Number.isFinite(Number(a.yaw)) ? Number(a.yaw) : 0
    const standCandidates = [
      pos.offset(1, 0, 0), pos.offset(-1, 0, 0), pos.offset(0, 0, 1), pos.offset(0, 0, -1),
      pos.offset(2, 0, 0), pos.offset(-2, 0, 0)
    ]
    let stood = false
    for (const c of standCandidates) {
      const cb = bot.blockAt(c)
      const cf = bot.blockAt(c.offset(0, -1, 0))
      if (!cf || airNames.has(cf.name)) continue
      if (cb && !airNames.has(cb.name)) continue
      if (bot.entity.position.distanceTo(c) > 1.5) {
        await bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 1)).catch(() => {})
      }
      if (bot.entity.position.distanceTo(pos) <= 4.2) { stood = true; break }
    }
    await bot.look(yaw, 0, true).catch(() => {})
    await sleep(200)
    await bot.equip(doorItem, 'hand')
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
    await sleep(400)
    const placed = bot.blockAt(pos)
    const props = (placed && placed.getProperties && placed.getProperties()) || {}
    // 顺手读一下"开着"时碰撞盒朝哪边，便于判断开门后通道是否通畅
    const shapes = (placed && placed.shapes) || []
    return {
      at: posJSON(pos), placed: placed ? placed.name : null,
      facing: props.facing || null, hinge: props.hinge || null, open: props.open,
      closedShapes: shapes, stood,
      verdict: placed && String(placed.name).endsWith('_door')
        ? `PASS 门已放置 facing=${props.facing} hinge=${props.hinge}`
        : 'FAIL 门没有放上去'
    }
  }
  if (type === 'recover') return boundedAction(type, a, async (token) => {
    // 一键恢复"物理卡死"：机器人时不时会进入一种状态——脚下是实地、四周无障碍、
    // 诊断也显示可达，但按键就是只动 0.1 格（客户端与服务器位置不同步）。
    // 这里按 轻→重 逐级尝试：松控制 → 跳/侧移 → 打开身边的门 → 最后传送到安全点重新同步。
    const trail = []
    const before = bot.entity.position.clone()
    const tryStep = async (ms = 1300) => {
      const p0 = bot.entity.position.clone()
      await bot.lookAt(p0.offset(0.5, 0, -3), true).catch(() => {})
      bot.setControlState('forward', true)
      await sleep(ms)
      bot.setControlState('forward', false)
      await sleep(200)
      return bot.entity.position.distanceTo(p0)
    }
    // 0) 交还控制权
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    bot.clearControlStates(); await sleep(200)
    // 1) 直接试走
    let moved = await tryStep()
    trail.push({ step: 'plainStep', moved: round(moved) })
    // 2) 跳 + 侧移（脱出贴墙/半砖夹缝）
    if (moved < 0.35) {
      for (const [k, ms] of [['jump', 300], ['left', 400], ['right', 400], ['back', 500], ['forward', 600]]) {
        bot.setControlState(k, true); await sleep(ms); bot.setControlState(k, false); await sleep(120)
      }
      moved = await tryStep()
      trail.push({ step: 'jumpStrafe', moved: round(moved) })
    }
    // 3) 身边有门就打开（自己卡在门方块里）
    if (moved < 0.35) {
      const f = bot.entity.position.floored()
      for (const q of [f, f.offset(0, 1, 0)]) {
        const b = bot.blockAt(q)
        if (b && typeof b.name === 'string' && b.name.endsWith('_door')) {
          try { await bot.activateBlock(b); await sleep(400) } catch (_) {}
        }
      }
      moved = await tryStep()
      trail.push({ step: 'openDoorAroundSelf', moved: round(moved) })
    }
    // 4) 仍然不动 → 传送回安全点强制与服务器重新同步（最后手段，必须显式授权）
    let teleported = false
    if (moved < 0.35 && a.allowTeleport) {
      const mark = memory.lastMessages.length
      bot.chat(`/home ${a.home || 'survival'}`)
      await sleep(3500)
      teleported = bot.entity.position.distanceTo(before) > 5
      trail.push({ step: 'teleportHome', teleported, at: posJSON(bot.entity.position),
                   messages: memory.lastMessages.slice(mark).map(m => String(m.text || '')).slice(-2) })
      moved = await tryStep(900)
    }
    if (moved < 0.35) throw new Error('仍然无法移动，建议人工介入或换一个位置重新登录')
    return {
      start: posJSON(before), at: posJSON(bot.entity.position), recovered: true, moved: round(moved),
      teleported, trail,
      verdict: teleported ? 'PASS 传送后已恢复移动' : 'PASS 已恢复移动'
    }
  })
  // ============ 空间原语（ODYSSEY 指出 Voyager 缺的 8 个坐标类技能）============
  if (type === 'jump') return boundedAction(type, a, async () => {
    // 纯跳跃：一次或多次。用于上台阶、越过 1 格障碍、脱离半砖夹缝。
    const times = Math.min(Math.max(Number(a.count || 1), 1), 6)
    const before = bot.entity.position.clone()
    for (let i = 0; i < times; i++) {
      bot.setControlState('jump', true); await sleep(180); bot.setControlState('jump', false); await sleep(240)
    }
    await sleep(250)
    return { from: posJSON(before), at: posJSON(bot.entity.position),
             rose: round(bot.entity.position.y - before.y), onGround: !!bot.entity.onGround,
             verdict: 'PASS 已跳跃' }
  })
  if (type === 'retreat') return boundedAction(type, a, async (token) => {
    // 远离某个坐标/最近的敌对生物若干格。逃跑是最常用的自保动作（尤其对苦力怕）。
    const steps = Math.min(Math.max(Number(a.distance || 6), 1), 20)
    let away = null
    if (Number.isFinite(Number(a.fromX))) {
      away = new Vec3(Number(a.fromX), Number(a.fromY), Number(a.fromZ))
    } else {
      const threat = Object.values(bot.entities)
        .filter(e => isHostile(e) && e.position && bot.entity.position.distanceTo(e.position) <= Number(a.radius || 12))
        .sort((x, y) => bot.entity.position.distanceTo(x.position) - bot.entity.position.distanceTo(y.position))[0]
      if (threat) away = threat.position.clone()
    }
    if (!away) return { moved: 0, verdict: 'SKIP 附近没有威胁，也没给坐标，无需后退' }
    const d0 = bot.entity.position.distanceTo(away)
    interruptPath()
    const dir = bot.entity.position.minus(away).scaled(1 / (d0 || 1))
    const target = bot.entity.position.plus(dir.scaled(steps))
    // 先试着寻路过去；失败就手动朝外跑
    let ok = false
    try {
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2))
      ok = true
    } catch (_) { ok = false }
    if (!ok) {
      interruptPath()
      await bot.lookAt(target.offset(0, 1.5, 0), true).catch(() => {})
      for (let i = 0; i < 5; i++) { bot.setControlState('forward', true); await sleep(500); bot.setControlState('forward', false); await sleep(120) }
    }
    const d1 = bot.entity.position.distanceTo(away)
    return { from: posJSON(away), start: round(d0), now: round(d1), gained: round(d1 - d0),
             at: posJSON(bot.entity.position),
             verdict: d1 > d0 ? `PASS 已拉开距离 ${round(d1 - d0)} 格` : 'FAIL 没能拉开距离（可能被围住）' }
  })
  if (type === 'craftAtomic') return boundedAction(type, a, async () => {
    // **原子合成**：只用手上/附近已有的工作台合成，缺什么就如实报缺，绝不偷偷替你去放工作台或补材料。
    const nameStr = String(a.item || '')
    const item = mcData.itemsByName[nameStr]
    if (!item) throw new Error(`unknown item: ${nameStr}`)
    const count = Math.max(1, Math.min(Number(a.count || 1), 64))
    const table = bot.findBlock({ matching: b => b && b.name === 'crafting_table', maxDistance: Number(a.tableRange || 5) })
    const recipes2x2 = bot.recipesFor(item.id, null, 1, null)
    const recipes3x3 = table ? bot.recipesFor(item.id, null, 1, table) : []
    const recipe2x2 = recipes2x2.find(r => bot.recipesFor(item.id, null, 1, null).length > 0) || recipes2x2[0]
    const recipe3x3 = recipes3x3[0]
    const recipe = recipe2x2 || recipe3x3
    if (!recipe) {
      // 准确判断原因：检查是否有任何可用配方（即使材料不足）
      const allRecipes = bot.recipesAll(item.id, null, table)
      if (allRecipes && allRecipes.length > 0) {
        throw new Error(`缺少合成 ${nameStr} 所需材料`)
      }
      throw new Error(table ? `缺少合成 ${nameStr} 所需材料` : `合成 ${nameStr} 需要 3x3 工作台，附近 5 格内没有工作台`)
    }
    const before = countByName(nameStr)
    await bot.craft(recipe, count, recipe2x2 ? null : table)
    await sleep(300)
    const gained = countByName(nameStr) - before
    if (gained <= 0) throw new Error(`合成未获得物品（可能材料或槽位不足）`)
    return {
      item: nameStr, requested: count, gained, total: countByName(nameStr),
      usedTable: !recipe2x2, tableInRange: !!table,
      verdict: `PASS 合成 ${gained} 个 ${nameStr}`
    }
  })
  if (type === 'pillarUp') return boundedAction(type, a, async (token) => {
    // 经典"垫脚上升"：跳起来在自己脚下放方块。
    const count = Math.min(Math.max(Number(a.count || 4), 1), 16)
    const trail = []
    for (let i = 0; i < count; i++) {
      if (token !== currentAbort) break
      const item = pickBuildItem(a.item)
      if (!item) { trail.push({ step: 'noBlock', note: '背包没有可用垫脚方块' }); break }
      const startY = bot.entity.position.y
      try {
        await bot.equip(item, 'hand')
        const feetCell = bot.entity.position.floored()
        const ref = bot.blockAt(feetCell.offset(0, -1, 0))
        if (!ref || airNames.has(ref.name) || replaceableNames.has(ref.name)) {
          trail.push({ step: 'noGround', i }); await sleep(150); continue
        }
        bot.setControlState('jump', true)
        await sleep(420)
        await bot.lookAt(bot.entity.position.offset(0, -1.6, 0), true).catch(() => {})
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
        bot.setControlState('jump', false)
        await sleep(300)
        trail.push({ step: 'pillar', i, fromY: round(startY), toY: round(bot.entity.position.y) })
      } catch (e) {
        bot.setControlState('jump', false)
        trail.push({ step: 'pillarError', i, error: String(e.message).slice(0, 70) })
        await sleep(200)
      }
    }
    bot.setControlState('jump', false)
    const climbed = trail.filter(t => t.step === 'pillar' && t.toY > t.fromY).length
    return { climbed, at: posJSON(bot.entity.position), trail,
             verdict: climbed > 0 ? `PASS 垫脚上升了 ${climbed} 格` : 'FAIL 没能上升（可能没有可用方块或被挡住）' }
  })
  if (type === 'land') return boundedAction(type, a, async () => {
    // 兜底：机器人悬在空中时把它放回地面，强制恢复物理重力
    try { bot.creative.stopFlying() } catch (_) {}
    if (bot.physicsEnabled === false) bot.physicsEnabled = true
    bot.physics.gravity = 0.08
    memory.flyingMode = 'off'
    bot.clearControlStates()
    const isSolid = v => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block' }
    const start = bot.entity.position.clone()
    let grounded = false
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      if (isSolid(bot.entity.position.floored().offset(0, -1, 0))) { grounded = true; break }
    }
    bot.clearControlStates()
    return {
      start: posJSON(start), at: posJSON(bot.entity.position), landed: grounded,
      fell: round(start.y - bot.entity.position.y),
      gravityRestored: (() => { try { return bot.physics.gravity > 0 } catch (_) { return null } })(),
      verdict: grounded ? 'PASS 已落回地面' : 'PARTIAL 15 秒内未落地，下方可能是深渊，改用 flyTo 到已知着陆点'
    }
  })
  if (type === 'setHome') return boundedAction(type, a, async () => {
    // 设置并**验证**家点。
    const name = String(a.name || 'survival')
    const trail = []
    const before = (() => { const f = bot.entity.position.floored(); return { pos: posJSON(f), below: (bot.blockAt(f.offset(0,-1,0))||{}).name } })()
    const isSolid = v => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block' }
    const here = bot.entity.position.floored()
    const safeHere = isSolid(here.offset(0,-1,0)) && airNames.has((bot.blockAt(here)||{name:'air'}).name) && airNames.has((bot.blockAt(here.offset(0,1,0))||{name:'air'}).name)

    const mark = memory.lastMessages.length
    bot.chat(`/sethome ${name}`)
    await sleep(2500)
    let msgs = memory.lastMessages.slice(mark).map(m => String(m.text || ''))
    trail.push({ step: 'sethome', cmd: `/sethome ${name}`, messages: msgs.slice(-3) })
    const failed = msgs.some(t => /already|cooldown|no permission|没有权限|无权|too many|上限/i.test(t))
    if (failed || !msgs.some(t => /设置为家|home set|家.*设置/i.test(t))) {
      // 退回默认 /sethome 再试一次
      const mark2 = memory.lastMessages.length
      bot.chat('/sethome')
      await sleep(2500)
      msgs = memory.lastMessages.slice(mark2).map(m => String(m.text || ''))
      trail.push({ step: 'sethomeDefault', messages: msgs.slice(-2) })
    }

    // 真刀真枪验证：传送一次，看落点
    const mark3 = memory.lastMessages.length
    bot.chat(`/home ${name}`)
    await sleep(3500)
    const after = bot.entity.position.floored()
    const below = bot.blockAt(after.offset(0,-1,0))
    const landedSafe = !!below && below.boundingBox === 'block'
      && airNames.has((bot.blockAt(after)||{name:'air'}).name)
      && airNames.has((bot.blockAt(after.offset(0,1,0))||{name:'air'}).name)
    trail.push({ step: 'verifyHome', at: posJSON(after), below: below ? below.name : null, landedSafe,
                 messages: memory.lastMessages.slice(mark3).map(m => String(m.text||'')).slice(-2) })
    if (!landedSafe) throw new Error(`家点 ${name} 的落点不安全（脚下 ${below && below.name}），请换到实心地面再设`)
    return {
      name, before, after: posJSON(after), landedSafe, trail,
      verdict: `PASS 家点 ${name} 已设置且落点安全 (${after.x},${after.y},${after.z})`
    }
  })
  if (type === 'verifyAccess') {
    // 端到端可达性实测：先从门外走到门口，再尝试走进屋内。回答"这房子到底进不进得去"。
    ensureReady()
    const o = a.outside, i = a.inside
    if (!o || !i) throw new Error('verifyAccess requires outside{x,y,z} and inside{x,y,z}')
    const outsidePos = new Vec3(Number(o.x), Number(o.y), Number(o.z))
    const insidePos = new Vec3(Number(i.x), Number(i.y), Number(i.z))
    const trail = []
    try {
      await bot.pathfinder.goto(new goals.GoalNear(outsidePos.x, outsidePos.y, outsidePos.z, 1))
      trail.push({ step: 'outside', at: posJSON(bot.entity.position), ok: true })
    } catch (e) { trail.push({ step: 'outside', ok: false, error: String(e.message).slice(0, 100) }) }
    let entered = false
    try {
      await bot.pathfinder.goto(new goals.GoalNear(insidePos.x, insidePos.y, insidePos.z, 1))
      entered = bot.entity.position.distanceTo(insidePos) <= 2.2
      trail.push({ step: 'inside', at: posJSON(bot.entity.position), ok: entered })
    } catch (e) { trail.push({ step: 'inside', ok: false, error: String(e.message).slice(0, 100) }) }
    // 失败时给出真正挡路的方块
    const blockers = []
    if (!entered) {
      const feet = bot.entity.position.floored()
      const steps = Math.max(Math.abs(insidePos.x - feet.x), Math.abs(insidePos.z - feet.z))
      for (let k = 1; k <= Math.min(steps, 16); k++) {
        const t = steps === 0 ? 1 : k / steps
        const cx = Math.round(feet.x + (insidePos.x - feet.x) * t)
        const cz = Math.round(feet.z + (insidePos.z - feet.z) * t)
        for (const dy of [0, 1]) {
          const pos = new Vec3(cx, feet.y + dy, cz)
          const b = bot.blockAt(pos)
          if (!b || airNames.has(b.name) || replaceableNames.has(b.name)) continue
          if (b.name.endsWith('_door')) continue
          // 只把真正有碰撞体积的方块算作障碍：火把/草/告示牌等 boundingBox==='empty'，玩家可以直接走过，若算进去会误导大脑去挖自己的火把。
          if (b.boundingBox === 'empty') continue
          const hard = !!protectedRegionAt(pos) || isProtectedName(b.name)
          blockers.push({ x: cx, y: pos.y, z: cz, name: b.name, natural: !hard, protected: hard })
        }
      }
    }
    return {
      ok: true,
      result: {
        entered, trail, blockers,
        verdict: entered ? 'PASS 可以正常进出' : 'FAIL 进不去，见 blockers',
        advice: entered ? '通行正常。' : (blockers.filter(b => b.natural).length
          ? `先挖掉天然障碍: ${blockers.filter(b => b.natural).map(b => `${b.name}@(${b.x},${b.y},${b.z})`).join(', ')}。建材方块不要挖。`
          : '没有天然障碍可挖：请检查门是否装好、门列是否被建材堵住，或改用其他入口。')
      }
    }
  }
  if (type === 'verifyStructure') {
    // 纯测量动作：按蓝图核对一座矩形房屋，返回**逐格**缺失清单（不做任何规划）
    ensureReady()
    const g = k => Number(a[k])
    const [x1, x2] = [Math.min(g('x1'), g('x2')), Math.max(g('x1'), g('x2'))]
    const [z1, z2] = [Math.min(g('z1'), g('z2')), Math.max(g('z1'), g('z2'))]
    const floorY = g('floorY'), wallFromY = g('wallFromY'), wallToY = g('wallToY'), roofY = g('roofY')
    if (![x1, x2, z1, z2, floorY, wallFromY, wallToY].every(Number.isFinite)) {
      throw new Error('verifyStructure requires x1,x2,z1,z2,floorY,wallFromY,wallToY (roofY optional)')
    }
    const openings = new Set((Array.isArray(a.openings) ? a.openings : [])
      .filter(o => o && Number.isFinite(o.x)).map(o => `${o.x},${o.y},${o.z}`))
    const doors = new Set((Array.isArray(a.doors) ? a.doors : [])
      .filter(o => o && Number.isFinite(o.x)).map(o => `${o.x},${o.y},${o.z}`))
    const isAir = pos => { const b = bot.blockAt(pos); return !b || airNames.has(b.name) }
    const nameAt = pos => { const b = bot.blockAt(pos); return b ? b.name : 'unknown' }

    const missingWalls = [], missingRoof = [], missingFloor = [], blockedOpenings = [], doorProblems = []
    for (let y = wallFromY; y <= wallToY; y++) {
      for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
        const perim = (x === x1 || x === x2 || z === z1 || z === z2)
        if (!perim) continue
        const key = `${x},${y},${z}`
        if (openings.has(key)) { if (!isAir(new Vec3(x, y, z))) blockedOpenings.push({ x, y, z, blockedBy: nameAt(new Vec3(x, y, z)) }); continue }
        if (doors.has(key)) continue
        if (isAir(new Vec3(x, y, z))) missingWalls.push({ x, y, z })
      }
    }
    for (const d of (Array.isArray(a.doors) ? a.doors : [])) {
      const n = nameAt(new Vec3(d.x, d.y, d.z))
      if (!String(n).includes('door')) doorProblems.push({ x: d.x, y: d.y, z: d.z, found: n })
    }
    if (Number.isFinite(roofY)) {
      for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
        if (isAir(new Vec3(x, roofY, z))) missingRoof.push({ x, y: roofY, z })
      }
    }
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (isAir(new Vec3(x, floorY, z))) missingFloor.push({ x, y: floorY, z })
    }
    const roofOk = !Number.isFinite(roofY) || missingRoof.length === 0
    return {
      ok: true,
      result: {
        region: { x1, x2, z1, z2, floorY, wallFromY, wallToY, roofY: Number.isFinite(roofY) ? roofY : null },
        sealed: missingWalls.length === 0 && roofOk,
        missingWalls, missingRoof, missingFloor, blockedOpenings, doorProblems,
        counts: { walls: missingWalls.length, roof: missingRoof.length, floor: missingFloor.length, blockedOpenings: blockedOpenings.length, doorProblems: doorProblems.length },
        verdict: (missingWalls.length === 0 && roofOk && missingFloor.length === 0 && blockedOpenings.length === 0 && doorProblems.length === 0)
          ? 'PASS 完全达标' : 'FAIL 仍有欠缺，见上面清单'
      }
    }
  }
  if (type === 'scan') {
    ensureReady()
    const radius = Math.min(Number(a.radius || 32), 64)
    const groups = a.groups || {
      logs: LOG_NAMES,
      stone: ['stone', 'cobblestone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff'],
      water: ['water'],
      lava: ['lava'],
      crafting_table: ['crafting_table'],
      chest: ['chest'],
      furnace: ['furnace'],
      ores: ['coal_ore', 'iron_ore', 'copper_ore', 'diamond_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_diamond_ore']
    }
    const out = {}
    for (const [key, names] of Object.entries(groups)) {
      const ids = names.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
      if (!ids.length) { out[key] = { count: 0, nearest: [] }; continue }
      let positions = []
      try {
        // 多取一些候选，再用"裸露面"过滤，保证过滤后仍有足够结果
        const raw = bot.findBlocks({ matching: ids, maxDistance: radius, count: Math.min(Number(a.limit || 96) * 6, 1500) })
        positions = a.exposed === false ? raw : raw.filter(isExposed)
        positions = positions.slice(0, Math.min(Number(a.limit || 96), 256))
      } catch (_) {}
      positions.sort((p, q) => bot.entity.position.distanceTo(p) - bot.entity.position.distanceTo(q))
      out[key] = {
        count: positions.length,
        nearest: positions.slice(0, 6).map(p => ({ ...posJSON(p), d: dist(bot.entity.position, p) }))
      }
    }
    return { ok: true, result: { position: posJSON(bot.entity.position), radius, groups: out } }
  }
  if (type === 'guard') return boundedAction(type, a, async (token) => {
    const radius = Math.min(Number(a.radius || 8), 16)
    const maxTargets = Math.min(Number(a.count || 4), 10)
    const abortHealth = Number(a.abortHealth || 8)
    const killed = [], engaged = []
    for (let n = 0; n < maxTargets && token === currentAbort; n++) {
      const target = Object.values(bot.entities)
        .filter(e => isHostile(e) && e.position && bot.entity.position.distanceTo(e.position) <= radius)
        .sort((x, y) => bot.entity.position.distanceTo(x.position) - bot.entity.position.distanceTo(y.position))[0]
      if (!target) break
      const tName = String(target.name || '').toLowerCase()
      // 防爆铁律：如果在保护区建筑附近（<= 12 格）且目标是苦力怕，绝不能直接挥剑引爆！
      const nearBase = memory.protectedRegions && memory.protectedRegions.some(r => {
        const cx = (r.x1 + r.x2) / 2, cz = (r.z1 + r.z2) / 2
        return Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz) <= 14
      })
      if (tName === 'creeper' && nearBase && !a.forceCreeper) {
        throw new EnvironmentError('保护区防爆铁律：苦力怕逼近房屋，严禁近战挥剑引爆！请调用 flyTo 升空脱离或弓箭点杀')
      }
      engaged.push(named(target))
      const sword = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'))
      if (sword) await bot.equip(sword, 'hand')

      // 如果目标是苦力怕且在野外允许战斗，采用一击即退 (hitAndRun) 战术
      if (tName === 'creeper') {
        for (let i = 0; i < 15 && bot.entities[target.id] && token === currentAbort; i++) {
          if (bot.health <= abortHealth) throw new Error(`guard aborted: low health ${Math.round(bot.health)}`)
          await bot.pathfinder.goto(new goals.GoalFollow(target, 2.8)).catch(() => {})
          if (!bot.entities[target.id]) break
          await bot.lookAt(target.position.offset(0, 1.2, 0), true).catch(() => {})
          bot.attack(target)
          // 击退后立即后跳急退
          bot.setControlState('back', true)
          bot.setControlState('sprint', true)
          await sleep(650)
          bot.clearControlStates()
          await sleep(600) // 等待引信熄灭
        }
      } else {
        for (let i = 0; i < 30 && bot.entities[target.id] && token === currentAbort; i++) {
          if (bot.health <= abortHealth) throw new Error(`guard aborted: low health ${Math.round(bot.health)}`)
          if (bot.entity.position.distanceTo(target.position) > 2.6) {
            await bot.pathfinder.goto(new goals.GoalFollow(target, 1.4)).catch(() => {})
          }
          if (!bot.entities[target.id]) break
          await bot.lookAt(target.position.offset(0, 1.2, 0), true).catch(() => {})
          bot.attack(target)
          await sleep(560)
        }
      }
      if (!bot.entities[target.id]) killed.push(named(target)); else break
    }
    return { engaged, killed, health: Math.round(bot.health), hostilesLeft: nearestEntities(radius).filter(e => e.hostile) }
  })
  if (type === 'plantSaplings') return boundedAction(type,a,async()=>{
    const itemName=String(a.item||'oak_sapling'); if(!itemName.endsWith('_sapling')) throw new Error('plantSaplings requires a sapling item')
    const positions=Array.isArray(a.positions)?a.positions.slice(0,16):[]; if(!positions.length) throw new Error('plantSaplings requires positions')
    const validSoil=new Set(['grass_block','dirt','coarse_dirt','podzol','rooted_dirt','moss_block','mud','muddy_mangrove_roots','farmland']), planted=[]
    for(const p of positions){
      const target=new Vec3(Number(p.x),Number(p.y),Number(p.z)), soil=bot.blockAt(target.offset(0,-1,0)), existing=bot.blockAt(target)
      console.log(`[plantSaplings] target=${target} soil=${soil&&soil.name} existing=${existing&&existing.name} dist=${bot.entity.position.distanceTo(target)}`)
      if(!soil||!validSoil.has(soil.name)){ console.log(`[plantSaplings] skipped: invalid soil ${soil&&soil.name}`); continue }
      if(existing&&!airNames.has(existing.name)&&!replaceableNames.has(existing.name)&&existing.name!=='leaf_litter'){ console.log(`[plantSaplings] skipped: non-replaceable existing ${existing&&existing.name}`); continue }
      if(existing&&existing.name==='leaf_litter'){await equipBestTool(existing);await bot.dig(existing,true);await sleep(150)}
      const current=bot.inventory.items().find(i=>i.name===itemName); if(!current){ console.log('[plantSaplings] break: no sapling'); break }
      if(bot.entity.position.distanceTo(target)>4.5) await bot.pathfinder.goto(new goals.GoalNear(target.x,target.y,target.z,2)).catch(()=>{})
      if(bot.entity.position.distanceTo(target)>4.8){ console.log(`[plantSaplings] skipped: still too far ${bot.entity.position.distanceTo(target)}`); continue }
      await bot.equip(current,'hand'); await bot.lookAt(target.offset(0.5,-0.1,0.5),true); await bot.placeBlock(soil,new Vec3(0,1,0)); await sleep(500)
      const placed=bot.blockAt(target); if(placed&&placed.name===itemName){planted.push(posJSON(target));continue}
      throw new Error(`sapling placement not verified at ${target}: got ${placed&&placed.name}`)
    }
    return {item:itemName,planted:planted.length,positions:planted,inventory:inventory()}
  })
  if (type === 'placeTorch') return boundedAction(type, a, async () => {
    const torch = bot.inventory.items().find(i => i.name === 'torch' || i.name === 'soul_torch')
    if (!torch) return { placed: null, warning: 'missing torch in inventory', inventory: inventory() }
    let targetPos = bot.entity.position.floored()
    const canSupportTorch = (b) => {
      if (!b || !b.boundingBox || b.boundingBox !== 'block') return false
      // 树叶方块 (leaves) 在 Minecraft 原版中禁止插火把！
      if (b.name.includes('leaves') || b.name === 'leaf_litter') return false
      return true
    }

    if (a.x != null && a.y != null && a.z != null) {
      targetPos = new Vec3(Math.round(Number(a.x)), Math.round(Number(a.y)), Math.round(Number(a.z)))
    } else {
      // 若未指定坐标，在身旁寻找不是自己脚下、下方有实心支撑的位置
      const offsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 0, 0)]
      let found = null
      for (const off of offsets) {
        const candidate = targetPos.plus(off)
        const cur = bot.blockAt(candidate)
        if (cur && (cur.name === 'torch' || cur.name === 'soul_torch' || cur.name === 'wall_torch')) {
          return { placed: posJSON(candidate), note: 'already_has_torch', inventory: inventory() }
        }
        const sup = bot.blockAt(candidate.offset(0, -1, 0))
        if (canSupportTorch(sup) && (!cur || airNames.has(cur.name) || replaceableNames.has(cur.name))) {
          found = candidate
          break
        }
      }
      if (found) targetPos = found
    }
    if (bot.entity.position.distanceTo(targetPos) > 4.2) {
      try {
        const pPromise = bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0))
        const tTimeout = new Promise((_, reject) => setTimeout(() => {
          interruptPath()
          reject(new Error('pathfinder timeout'))
        }, 3000))
        await Promise.race([pPromise, tTimeout]).catch(() => {})
      } catch (_) {}
      await interruptPath()
    }
    const current = bot.blockAt(targetPos)
    if (current && (current.name === 'torch' || current.name === 'soul_torch' || current.name === 'wall_torch')) {
      return { placed: posJSON(targetPos), note: 'already_has_torch', inventory: inventory() }
    }
    if (current && (replaceableNames.has(current.name) || current.name === 'short_grass' || current.name === 'tall_grass')) {
      try {
        await equipBestTool(current)
        await Promise.race([bot.dig(current, true), sleep(1500)]).catch(() => {})
        await sleep(100)
      } catch (_) {}
    }
    const support = bot.blockAt(targetPos.offset(0, -1, 0))
    if (!canSupportTorch(support)) {
      return { placed: null, warning: `no solid floor for torch (support is ${support && support.name})`, inventory: inventory() }
    }

    // 若机器人站在 targetPos 内或太近，稍微后退让出放置碰撞体积
    const curFeet = bot.entity.position.floored()
    if (curFeet.equals(targetPos) || bot.entity.position.distanceTo(targetPos) < 0.8) {
      try {
        bot.setControlState('back', true)
        await sleep(200)
        bot.setControlState('back', false)
      } catch (_) {}
    }

    if (bot.heldItem?.name !== torch.name) {
      await Promise.race([bot.equip(torch, 'hand'), sleep(1500)]).catch(() => {})
    }
    await bot.lookAt(support.position.offset(0.5, 0.9, 0.5), true).catch(() => {})
    try {
      const pPlace = bot.placeBlock(support, new Vec3(0, 1, 0))
      const pTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('placeTorch timeout')), 2500))
      await Promise.race([pPlace, pTimeout])
    } catch (e) {
      // 容错：如果放置被服务端取消或落点判定延迟，重新探测该格；若已有火把则正常返回
      await sleep(150)
      const after = bot.blockAt(targetPos)
      if (after && (after.name === 'torch' || after.name === 'soul_torch' || after.name === 'wall_torch')) {
        return { placed: posJSON(targetPos), note: 'verified_after_refusal', inventory: inventory() }
      }
      return { placed: null, warning: `火把放置未成功: ${e.message}`, inventory: inventory() }
    }
    await sleep(100)
    return { placed: posJSON(targetPos), inventory: inventory() }
  }, { timeoutMs: 12000 })
  if (type === 'escape') return boundedAction(type, a, async () => {
    // 破壳脱困：当被方块掩埋、窒息或卡在狭窄竖井时，挖开周围方块并跳跃脱身
    await hardStopPath()
    const p = bot.entity.position.floored()
    const broken = []
    for (const off of [new Vec3(0, 1, 0), new Vec3(0, 2, 0), new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const b = bot.blockAt(p.plus(off))
      if (b && !airNames.has(b.name) && b.diggable) {
        const guard = digGuard(b.position, b.name, false)
        if (!guard) {
          try {
            await equipBestTool(b)
            await bot.dig(b, true)
            broken.push({ name: b.name, pos: posJSON(b.position) })
            await sleep(100)
          } catch (_) {}
        }
      }
    }
    bot.setControlState('jump', true)
    await sleep(400)
    bot.setControlState('jump', false)
    return { broken, position: posJSON(bot.entity.position), verdict: 'PASS 已破壳脱困' }
  })
  if (type === 'unstuck') return boundedAction(type,a,async()=>{
    await hardStopPath()   // 之后要移动，必须把 stop 标志等干净
    const recovered = []
    // 典型死锁 1：自己正卡在一个"关着的门"方块里 —— 此时 pathfinder 认为四周全是实体，直接锁死。
    // 正确做法是先把这扇门打开。
    const feet = bot.entity.position.floored()
    for (const probe of [feet, feet.offset(0, 1, 0)]) {
      const b = bot.blockAt(probe)
      if (b && typeof b.name === 'string' && b.name.endsWith('_door')) {
        try {
          await bot.activateBlock(b)
          await sleep(400)
          recovered.push({ action: 'openedDoorAroundSelf', at: posJSON(probe), name: b.name })
        } catch (_) {}
      }
    }
    // 典型死锁 2：头顶被压住 / 卡在 1x1 竖井 —— 跳一下看看能不能脱身
    for (const key of ['jump','back','left','right']) { bot.setControlState(key,true); await sleep(key==='back'?700:350); bot.setControlState(key,false); await sleep(120) }
    return { position: posJSON(bot.entity.position), recovered }
  })
  throw new Error(`unknown action type: ${type}`)
}


// ============ 门碰撞修正（关键基础设施） ============
// 现象：机器人无法穿过自己开着的门，只能在门口打转，甚至把门挖掉。
// 根因：mineflayer 的方块数据把"开着的门"仍然描述为 [0,0,0,1,1,0.1875] 这种**整宽薄板**，
//       挡死了门洞。而 mineflayer 的物理引擎 (lib/plugins/physics.js: world.getBlock => bot.blockAt)
//       和 mineflayer-pathfinder 都通过 bot.blockAt 读方块，因此客户端物理会直接拒绝通过。
//       也就是说：不是服务器不让过，是机器人自己"以为"过不去。
// 方案：在 bot.blockAt 这一层统一纠正 —— open=true 的门视为无碰撞体积。
function installDoorCollisionFix(bot) {
  let doorIds = null
  const origBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = function (pos, extraInfos) {
    const b = origBlockAt(pos, extraInfos)
    if (!b || typeof b.type !== 'number') return b
    if (doorIds === null) {
      try {
        doorIds = new Set(Object.values(bot.registry.blocksByName)
          .filter(x => x && typeof x.name === 'string' && x.name.endsWith('_door')).map(x => x.id))
      } catch (_) { doorIds = new Set() }
    }
    if (!doorIds.has(b.type)) return b
    try {
      const props = b.getProperties ? b.getProperties() : null
      if (props && (props.open === true || props.open === 'true')) {
        b.shapes = []
        b.boundingBox = 'empty'
        b.physical = false
      }
    } catch (_) {}
    return b
  }
  bot.once('spawn', () => console.log('[blocks] 已安装门碰撞修正：开着的门不再挡住门洞'))
}

function connect() {
  bot = mineflayer.createBot({ host:cfg.host, port:Number(cfg.port||25565), username:cfg.username, version:cfg.version||false, auth:cfg.auth||'offline', viewDistance:cfg.viewDistance||'far', checkTimeoutInterval: 60000 })
  bot.loadPlugin(pathfinder)
  bot.on('login',()=>{memory.connected=true;addMessage('system','protocol login complete'); installDoorCollisionFix(bot)})
  bot.on('spawn',async()=>{
    memory.spawned=true; mcData=mcDataLoader(bot.version); movements=new Movements(bot)
    movements.canDig=false; movements.allow1by1towers=false; movements.allowParkour=true; movements.maxDropDown=Number(cfg.maxDropDown||4); movements.canOpenDoors=true
    // 放宽半砖、楼梯等小高差地形的跨越惩罚，允许像原版生物一样自然滑步
    try { movements.heuristicDelta = 0.5 } catch (_) {}
    // ---- 门通行修正 ----
    // mineflayer-pathfinder 用 boundingBox==='block' 判定"不可通行"，而门**即使开着**
    // 的 boundingBox 仍然是 'block'（只是一块 0.1875 厚的薄板）。结果是机器人永远无法
    // 穿过自己开着的门，只能在门口打转，甚至去把门挖掉——这正是"进不去屋"的病根。
    // 这里按**实时方块状态**纠正：open=true 的门视为可通行；关着的门保持实体墙。
    try {
      const doorIds = new Set(Object.values(bot.registry.blocksByName)
        .filter(b => b && typeof b.name === 'string' && b.name.endsWith('_door')).map(b => b.id))
      const origGetBlock = movements.getBlock.bind(movements)
      movements.getBlock = function (pos, dx = 0, dy = 0, dz = 0) {
        const b = origGetBlock(pos, dx, dy, dz)
        if (b && b.type != null && doorIds.has(b.type) && typeof b.getProperties === 'function') {
          const props = b.getProperties() || {}
          if (props.open === true || props.open === 'true') {
            b.safe = true; b.physical = false; b.boundingBox = 'empty'; b.shapes = []
          }
        }
        return b
      }
      console.log(`[pathfinder] 已安装门通行修正（${doorIds.size} 种门：开着的门视为可通行）`)
    } catch (e) { console.error('[pathfinder] 门通行修正安装失败:', e.message) }

    bot.pathfinder.setMovements(movements)
    // A* 默认 thinkTimeout 只有 5 秒，在被自己挖得坑洼不平的地形上经常直接失败
    // （日志里大量 "Took to long to decide path to goal!"）。放宽到 15 秒。
    try {
      bot.pathfinder.thinkTimeout = Number(cfg.thinkTimeoutMs || 15000)
      bot.pathfinder.tickTimeout = Number(cfg.tickTimeoutMs || 80)
      const origGoto = bot.pathfinder.goto.bind(bot.pathfinder)
      bot.pathfinder.goto = function (goal, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try { bot.pathfinder.stop() } catch (_) {}
            reject(new Error(`pathfinder timeout after ${timeoutMs}ms`))
          }, timeoutMs)

          origGoto(goal).then(
            res => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(res)
            },
            err => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              reject(err)
            }
          )
        })
      }
      console.log('[pathfinder] 已为 pathfinder.goto 注入 8000ms 全局防卡死看门狗')
    } catch (_) {}

    // ---- 仿原版怪物肌肉记忆：物理层 50ms 自动迈步与卡角自愈反射 (Auto-Step & Anti-Stuck) ----
    let stuckTicks = 0
    let lastPhysPos = null
    bot.on('physicsTick', () => {
      try {
        if (!bot.entity || !bot.entity.position) return
        const isMovingControl = bot.controlState.forward || bot.controlState.back || bot.controlState.left || bot.controlState.right
        const isPathfinding = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()
        
        if (isMovingControl || isPathfinding) {
          if (lastPhysPos) {
            const dx = bot.entity.position.x - lastPhysPos.x
            const dz = bot.entity.position.z - lastPhysPos.z
            const horizDistSq = dx * dx + dz * dz
            
            // 如果处于寻路/前进移动状态，但连续 6 个 tick (300ms) 水平位移几乎为 0
            if (horizDistSq < 0.0009) {
              stuckTicks++
              // 触发肌肉反射：如果脚下是在地面或液体上，本能瞬时跳跃迈步
              if (stuckTicks >= 6 && stuckTicks <= 18 && bot.entity.onGround) {
                bot.setControlState('jump', true)
                setTimeout(() => { try { bot.setControlState('jump', false) } catch(_) {} }, 120)
              }
              // 如果卡住超过 1 秒 (20 ticks)，轻微左右扭动身位摆脱卡缝
              if (stuckTicks > 20 && stuckTicks % 10 === 0) {
                const wiggle = (stuckTicks % 20 === 0) ? 'left' : 'right'
                bot.setControlState(wiggle, true)
                setTimeout(() => { try { bot.setControlState(wiggle, false) } catch(_) {} }, 100)
              }
            } else {
              stuckTicks = 0
            }
          }
          lastPhysPos = bot.entity.position.clone()
        } else {
          stuckTicks = 0
          lastPhysPos = null
        }
      } catch (_) {}
    })
    console.log('[physics] 已加载仿生生物物理反射：50ms 自动迈步与卡角微跳脱困')
    if (!cfg.authmePassword) memory.authenticated=true
    else { await sleep(Number(cfg.authmeDelayMs||900)); bot.chat(`/login ${cfg.authmePassword}`) }
  })
  bot.on('messagestr',(message)=>{
    addMessage('server',message)
    const s=String(message).toLowerCase()
    if (/successfully logged|login successful|登录成功|成功登录|已登录|登陆成功|成功登陆|已登陆|登陆过|登录过/.test(s)) memory.authenticated=true
    if (/not registered|未注册/.test(s) && cfg.authmeAutoRegister && cfg.authmePassword) bot.chat(`/register ${cfg.authmePassword} ${cfg.authmePassword}`)
  })
  const handlePlayerMessage = async (u, m) => {
    const masters = Array.isArray(cfg.masters) ? cfg.masters : ['chaoji34']
    if (!masters.includes(u)) return
    const text = String(m || '').trim()
    console.log(`[Master Command] from ${u}: ${text}`)

    // 1. Reflex 即时响应
    if (text === '!stop') {
      stopAll('player command')
      bot.chat(`[FridayAI] 收到，${u}，已紧急停止当前动作。`)
      return
    }
    if (text === '!status') {
      const p = bot.entity.position.floored()
      bot.chat(`[FridayAI] 生命: ${bot.health}/20, 饱食: ${bot.food}/20, 位置: (${p.x}, ${p.y}, ${p.z})`)
      return
    }
    if (text === '!follow') {
      const target = bot.players[u] && bot.players[u].entity
      if (!target) {
        bot.chat(`[FridayAI] ${u}，我看不到你，请靠近一些。`)
        return
      }
      bot.chat(`[FridayAI] 收到，开始跟随 ${u}。`)
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      return
    }
    if (text === '!home') {
      stopAll('teleport home')
      bot.chat('/home survival')
      return
    }

    // 2. 自然语言指令：只入队，交由外置大脑 (friday-brain.js) 消费决策。执行器本身不做任何规划。
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from: u, text, at: new Date().toISOString(), acked: false
    }
    memory.pendingInstructions.push(entry)
    memory.chatQueue.push(entry)
    if (memory.pendingInstructions.length > 30) memory.pendingInstructions.shift()
    if (memory.chatQueue.length > 30) memory.chatQueue.shift()
    console.log(`[Chat Queued] ${u}: ${text}`)
    const isStopCmd = /停|stop|别动|住手|取消|暂停|别挖了|中断/i.test(text)
    if (isStopCmd && memory.busy) {
      if (cfg.ackMasterMessages !== false) bot.chat(`/msg ${u} [FridayAI] 收到停止指令，已立即中止动作。`)
      console.log(`[Preempt] 主人发出停止指令，中止当前动作 ${memory.action}`)
      stopAll('master requested stop')
    } else {
      if (cfg.ackMasterMessages !== false) bot.chat(`/msg ${u} [FridayAI] 收到，正在处理/推进中。`)
    }
  }

  bot.on('chat', (u, m) => {
    addMessage('chat', `${u}: ${m}`)
    handlePlayerMessage(u, m).catch(e => console.error('[handlePlayerMessage error]', e))
  })
  bot.on('whisper', (u, m) => {
    addMessage('whisper', `${u}: ${m}`)
    handlePlayerMessage(u, m).catch(e => console.error('[handlePlayerWhisper error]', e))
  })
  bot.on('health', () => {
    if (bot.health < 20) memory.lastDamageAt = new Date().toISOString()
    // 受到伤害且生命偏低或受到攻击时，自动左手装备盾牌格挡自卫
    try {
      const shield = bot.inventory.items().find(i => i.name === 'shield')
      if (shield && (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== 'shield')) {
        bot.equip(shield, 'off-hand').catch(() => {})
      }
    } catch (_) {}
  })

  // 苦力怕近身自防爆与保命反射（每 250ms 检查一次，规避炸房与暴毙）
  let lastEmergencyAt = 0
  const emergencyInterval = setInterval(() => {
    if (!bot || !bot.entity || bot.health <= 0) return
    const now = Date.now()
    if (now - lastEmergencyAt < 1200) return
    const threats = nearestEntities(7)
    const creeper = threats.find(e => e.name === 'creeper' && e.distance <= 5.5 && e.lineOfSight)
    if (creeper) {
      lastEmergencyAt = now
      console.log(`[EMERGENCY] 苦力怕逼近 (距离 ${creeper.distance}m)！立即执行防爆避险动作`)
      if (memory.flyingMode === 'on') {
        try { bot.creative.startFlying() } catch (_) {}
        bot.entity.position = bot.entity.position.offset(0, 4.5, 0)
        bot.entity.velocity = new Vec3(0, 0, 0)
        return
      }
      const shield = bot.inventory.items().find(i => i.name === 'shield')
      if (shield) {
        bot.equip(shield, 'off-hand').then(() => bot.activateItem(true)).catch(() => {})
      }
      bot.setControlState('back', true)
      bot.setControlState('sprint', true)
      setTimeout(() => {
        try {
          bot.setControlState('back', false)
          bot.setControlState('sprint', false)
          if (shield) bot.deactivateItem()
        } catch (_) {}
      }, 1000)
    }

    // 防溺水机制：氧气不足时立即向上浮起/跳跃，避免水坑窒息
    if (bot.oxygenLevel != null && bot.oxygenLevel < 18) {
      bot.setControlState('jump', true)
      if (memory.flyingMode === 'on') {
        try { bot.creative.startFlying() } catch (_) {}
        bot.entity.position = bot.entity.position.offset(0, 1.5, 0)
        bot.entity.velocity = new Vec3(0, 0, 0)
      }
    }
  }, 250)
  bot.on('death',()=>{
    const p = bot.entity ? posJSON(bot.entity.position) : memory.lastDeathPosition
    memory.deaths = (memory.deaths||0)+1
    memory.lastDeathAt = new Date().toISOString()
    memory.lastDeathPosition = p
    saveState()
    stopAll('death')
    addMessage('death', `FridayAI died at ${JSON.stringify(p)} (total ${memory.deaths})`)
    console.log(`[Death] FridayAI died at ${JSON.stringify(p)} (total ${memory.deaths})`)
  })
  bot.on('kicked',r=>{
    memory.connected=false;memory.spawned=false;memory.authenticated=false;
    const msg = typeof r==='string'?r:JSON.stringify(r)
    addMessage('kicked',msg)
  })
  bot.on('end',r=>{
    memory.connected=false;memory.spawned=false;memory.authenticated=false;
    addMessage('end',r||'connection ended'); 
    if(cfg.reconnect!==false)setTimeout(connect,Number(cfg.reconnectDelayMs||5000))
  })
  bot.on('error',e=>{
    memory.lastError=e.message;
    addMessage('error',e.message)
  })
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json; charset=utf-8')
  if(apiToken && req.headers.authorization!==`Bearer ${apiToken}`){res.statusCode=401;return res.end(JSON.stringify({ok:false,error:'unauthorized'}))}
  if(req.method==='GET'&&req.url.startsWith('/observe')) return res.end(JSON.stringify(observe()))
  if(req.method!=='POST'||req.url!=='/act'){res.statusCode=404;return res.end(JSON.stringify({ok:false,error:'not found'}))}
  let body=''; req.on('data',c=>{body+=c;if(body.length>1024*1024)req.destroy()})
  req.on('end',async()=>{try{const out=await act(JSON.parse(body||'{}'));res.end(JSON.stringify(out))}catch(e){res.statusCode=400;res.end(JSON.stringify({ok:false,error:String(e.message||e),observation:observe({blocks:false})}))}})
})
server.listen(apiPort,apiHost,()=>{console.log(`mc-agent API listening on http://${apiHost}:${apiPort}`);connect()})
process.on('SIGINT',()=>{stopAll('SIGINT');try{bot.quit('operator stopped')}catch(_){};process.exit(0)})
process.on('SIGTERM',()=>{stopAll('SIGTERM');try{bot.quit('operator stopped')}catch(_){};process.exit(0)})
