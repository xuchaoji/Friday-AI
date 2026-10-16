# 执行器动作协议

入口：`python3 scripts/mcctl.py act <type> '<JSON参数>'`。所有动作都是有界的；动作后重新 `observe`，不要把几十分钟任务塞进一次动作。

**统一返回信封：** 所有动作都返回 `{"ok":true,"result":{...}}`（失败为 `{"ok":false,"error":"..."}`）。判定成功一律看 `result` 里的客观数据，不看"动作发出去了"。

**红线：** 执行器不提供"整栋房子"这种复合动作。建筑必须由大脑用下面的原子原语逐步完成（放一块 → 砌一段 → 铺一层 → 挖一片）。若你现在想加一个 `buildHouse`，说明规划写错了地方。

## 观察与中止

```bash
mcctl.py observe --entity-radius 20 --block-radius 6
mcctl.py act stop '{"reason":"replan"}'
mcctl.py act status '{}'
mcctl.py act scan '{"radius":32}'
mcctl.py act inspect '{"x1":1,"y1":62,"z1":85,"x2":8,"y2":68,"z2":92,"list":true}'
```

| 动作 | 用途 |
|---|---|
| `status` | 自身状态：坐标/血量/饱食/忙闲/上次错误/死亡次数/锚点。不掉血、不改世界。 |
| `scan` | 按组统计周围资源：`logs`/`stone`/`ores`/`water`/`lava`/`crafting_table`/`chest`/`furnace`，每组给出数量与最近坐标。 |
| `inspect` | 精确查某区域的方块统计（可选 `list:true` 返回逐块坐标），**验收建造结果就靠它**。体积上限 40000。 |

观察结果重点：

- `ready`：已生成且通过 AuthMe；false 时不要执行世界动作。
- `self`：坐标、生命、饱食、氧气、维度、时间、天气、手持物。
- `contact`：脚部、头部、脚下方块。
- `entities`：实体 ID、距离、位置、是否敌对。
- `blocks`：附近非空气方块，最多返回限制数量。
- `memory`：当前动作、上次错误、服务器消息、受伤时间、`chatQueue`（待大脑消费的主人指令）、`deaths`。

## 建筑原语

```bash
# 砌一段：从 (x,y,z) 起沿一个方向放 count 块（count ≤ 16）
mcctl.py act buildLine '{"x":20,"y":64,"z":92,"dx":1,"dz":0,"count":7,"item":"cobblestone"}'

# 铺一层/一面：填一个长方体（总块数 ≤ 64）
mcctl.py act buildLayer '{"x1":20,"y1":67,"z1":92,"x2":26,"y2":67,"z2":96,"item":"cobblestone"}'

# 挖一片：找平场地或拆除旧建筑（总块数 ≤ 64）
mcctl.py act clearArea '{"x1":20,"y1":63,"z1":92,"x2":26,"y2":66,"z2":96}'
```

- 三者都会自动选材（背包里的木板→石料）、自动走近、自动挖掉挡路的自然方块（草/土/树叶），并在放置后**校验目标格**。
- `item` 可省略，此时按木板→石料顺序自动挑选；也可以指定 `"item":"birch_planks"`。
- 单次上限是刻意的：把大工程拆成多次调用，让 AI 每次都能看到真实进展并按需改计划。超限会直接报错而不是硬撑。
- `buildLine` 的 `dx/dy/dz` 必须恰好一个非零。`clearArea` 绝不会挖机器人自己脚下或身体所在的方块。

## 合成

```bash
mcctl.py act craftChain '{"item":"birch_door","count":1}'
mcctl.py act craftChain '{"item":"crafting_table","count":1}'
mcctl.py act craftChain '{"item":"torch","count":8}'
```

`craftChain` 是纯机械动作：先找附近的 3×3 工作台，找不到就用背包木板合成一个并放到地上（位置记在 `memory.ownCraftingTable`，便于回收，绝不误挖玩家的工作台），然后在工作台上合成目标物品。返回 `gained`/`total` 表示真实增量。缺材料或没有配方时会明确报错——此时大脑应先去砍树/挖矿，而不是重复调用。

## 移动

```bash
mcctl.py act move '{"x":160,"y":64,"z":155,"range":1,"maxDistance":48}'
mcctl.py act follow '{"player":"master","range":3,"durationMs":5000}'
mcctl.py act look '{"entityId":123}'
mcctl.py act unstuck '{}'
```

只发短航段（室外通常 8–32 格，洞穴 3–12 格），每段后观察。`move` 默认不允许寻路自动挖方块、搭 1×1 塔或跑酷。路径失败后不要原参数无限重试；观察、换 waypoint、后退或 `unstuck`。

## 战斗

```bash
mcctl.py act attack '{"entityId":123,"maxHits":5,"abortHealth":9}'
mcctl.py act attack '{"name":"zombie","radius":12,"maxHits":8,"abortHealth":8}'
mcctl.py act guard '{"radius":8,"count":3}'
```

不提供名称或 ID 时只攻击敌对生物。默认不得攻击玩家、村民、宠物、中立生物和牲畜。苦力怕优先拉开距离；骷髅优先找掩体或快速贴近；末影人不要主动看眼睛或攻击；生命低于阈值时撤退。`guard` 是"清掉附近这一批怪"的有界动作，返回 `killed` 与 `hostilesLeft`。

## 挖掘与砍树

```bash
mcctl.py act mine '{"names":["coal_ore","deepslate_coal_ore"],"count":4,"radius":12}'
mcctl.py act mine '{"name":"stone","count":3,"radius":6}'
mcctl.py act chop '{"count":6,"radius":18}'
```

`mine` 会拒绝挖正脚下承重块，自动走到可触及位置并选择较好的工具，但不会判断领地权、矿洞整体稳定、熔岩源或树木所有权——这些由 AI 在每次动作前后观察决定。挖矿每批 1–8 块为宜；砍树先确认是自然树木而非建筑，并检查上方原木。

规则分支采矿优先使用：

```bash
mcctl.py act branchMine '{"dx":1,"dz":0,"length":8,"oreLimit":12,"abortHealth":14}'
```

`branchMine` 在当前高度开 2 格高的水平短巷，逐步检查水、熔岩和 8 格内敌对生物；发现附近煤、铁、铜会在安全触及范围内开采，并尝试走到掉落物旁。返回值包含实际矿石列表、库存变化和剩余状态。它仍是一次有界动作，不得把长度无限放大。

## 物品、交互与放置

```bash
mcctl.py act equip '{"item":"iron_sword","destination":"hand"}'
mcctl.py act use '{"item":"bread"}'
mcctl.py act place '{"item":"torch","reference":{"x":160,"y":63,"z":160},"face":{"x":0,"y":1,"z":0}}'
```

`place.reference` 是被点击的已有方块，`face` 是放置方向。执行器会先验证目标格可替换，并在放置后核对实际方块。已知目标坐标时优先使用：

```bash
mcctl.py act placeAt '{"item":"furnace","x":193,"y":61,"z":4}'
mcctl.py act placeAt '{"item":"birch_door","x":23,"y":64,"z":92}'
```

`placeAt` 会自动选择相邻实体方块作为点击面，避免把目标坐标误当 reference；门、床、火把、箱子、熔炉都走它。树苗不要使用通用 `placeAt`；使用会校验土壤、清除落叶并逐格核验方块的专用动作：

```bash
mcctl.py act plantSaplings '{"item":"oak_sapling","positions":[{"x":200,"y":68,"z":8}]}'
```

`plantSaplings` 只把最终世界中确实存在的树苗计为成功。各树苗通常间隔至少 4 格，并确认上方有足够生长空间。容器交互目前仅负责打开；复杂库存搬运应扩展执行器后再做，禁止用不可靠的鼠标宏。

拾取物品时使用 `collect`，并以 `picked`、`gained` 和最终库存为准，不再把寻路尝试次数当作成功数量。熔炼 `smelt` 会先取出炉内残留输入、燃料和输出，再放入新配方，减少 `destination full`。

背包被普通石料塞满时，可有限丢弃白名单内的低价值方块：

```bash
mcctl.py act discard '{"names":["cobblestone"],"maxStacks":3}'
```

`discard` 只允许圆石、泥土、花岗岩、闪长岩、安山岩、砂砾、落叶、按钮、草和腐肉；默认最多1组，必须保留足够建筑石料，绝不用于矿石、食物、工具、木材、燃料或贵重物品。

## 门与进出房间

```bash
# 查看门的开合状态 / 开 / 关 / 切换
mcctl.py act door '{"x":4,"y":64,"z":87}'
mcctl.py act door '{"x":4,"y":64,"z":87,"state":"open"}'
mcctl.py act door '{"x":4,"y":64,"z":87,"state":"close"}'
mcctl.py act door '{"radius":8,"state":"toggle"}'          # 不开坐标就找最近的门

# 开门 → 穿过 → 随手关门（via = 门洞另一侧"没门的那一格"）
mcctl.py act passDoor '{"door":{"x":4,"y":64,"z":87},"via":{"x":5,"y":64,"z":87},"to":{"x":4,"y":64,"z":89}}'
mcctl.py act passDoor '{"door":{"x":4,"y":64,"z":87},"via":{"x":5,"y":64,"z":87},"to":{"x":4,"y":64,"z":83}}'
```

- `door` 会走进交互距离、右键门，然后**读回门的 `open` 属性**再下结论；`verified:true` 才算真的开关成功。上半格会自动换算到下半格。
- `passDoor` 返回 `verdict`：`PASS 已穿过门并随手关门` / `PARTIAL ...` / `FAIL ...`，并带完整 `trail`（每一步的实际坐标）。它会：开门 → 依次经过 `via` 和目标点（寻路失败自动退回"对准+短促前进"的物理迈步）→ 离开门洞那一格 → 折返到门前 3 格 → 关门。

### ⚠ 门洞必须留 2 格宽（血泪教训）

**1 格宽的门洞，门打开后仍然可能过不去。** 原因：门的开合只改变碰撞盒的**朝向**，碰撞盒本身始终是一块 0.1875 厚的薄板（`boundingBox` 依然是 `block`，不是 `empty`）。当门的 `facing` 让这块薄板横在通道方向上时，整格通道就被它切断了——表现是"能从屋里走出来 / 走进不去"这类**单向通行**的怪现象，而不是简单的打不开。

实测（1.21.11，门在沿 X 方向的墙上，门洞沿 Z 方向）：
| 门状态 | shapes | 能否沿 Z 通过 |
|---|---|---|
| `open=false` | `[0,0,0,1,1,0.1875]` | 否（正常，关着就该挡） |
| `open=true, facing=east` | `[0,0,0,1,1,0.1875]` | **否**（薄板横在通道上 → 卡死） |
| `open=true, facing=north` | `[0,0,0,0.1875,1,1]` | 是（薄板顺着通道方向） |

**因此建造规范固定为：门洞至少 2 格宽——一格装门，另一格留空作为真正的通道**，并把那个空格传给 `passDoor` 的 `via`。这样无论门朝哪边开都不影响进出，也是真实玩家造房子的做法。

另外 `mc-agent.js` 里装了**门碰撞修正**（`installDoorCollisionFix`）：mineflayer 的物理引擎
(`lib/plugins/physics.js` 的 `world.getBlock => bot.blockAt`) 和 pathfinder 都通过 `bot.blockAt`
读方块，所以在那一层把 `open=true` 的门改成无碰撞，修掉"客户端自己以为过不去"的问题。

### 纪律

- **门不是障碍物**：`diagnose`、`move`、`verifyStructure` 都把门视为可通过；`isProtectedName` 让所有破坏动作拒绝挖门。**任何情况下都不要挖门来"解决"通行问题**。
- 进不去时先 `diagnose`，看真正挡路的是不是门外的天然方块（草/土/沙，可挖）；建材方块不要挖，改用 `passDoor` + `via` 或换入口。
- **进出房间随手关门**：开着的门等于给僵尸开门。离开时把自己开的门带上。也不要反复开关门浪费回合。
- 卡在门洞里出不来（自己站在门方块那一格）：直接 `unstuck`，它会自动把身边的门打开。

## 诊断动作

```bash
mcctl.py act diagnose '{"x":4,"y":64,"z":89}'      # 回答"我为什么到不了那里"
mcctl.py act probeBlock '{"x":4,"y":64,"z":87}'    # 这个方块在物理引擎眼里是什么形状
mcctl.py act stepTest '{"dir":"forward","dz":-3,"ms":1600}'   # 单纯按键前进，验证物理能否移动
```

- `diagnose`：报告可达性（`reachable`/`pathStatus`）、直线上的挡路方块（区分 `natural` 天然可挖 / 建材勿挖）、附近门的位置与 `advice`。**纯测量，不改世界。**
- `probeBlock`：返回 `name/properties/boundingBox/shapes/physical`。排查"为什么过不去"时先看它——能立刻分辨是门、是墙体、还是无碰撞装饰物。
- `stepTest`：交还寻路控制后直接按键前进并采样坐标。`physicsFrozen:true` 说明是物理层被卡住，而不是寻路算不出路。

## 生存与脱困

```bash
mcctl.py act eat '{}'                                  # 吃东西（不指定就用背包里任意食物）
mcctl.py act eat '{"item":"cooked_beef"}'
mcctl.py act fly '{"state":"on"}'                      # 开/关飞行（EssentialsX /fly，幂等）
mcctl.py act flyTo '{"x":16,"y":64,"z":84}'            # 立体飞到目标点
mcctl.py act land '{}'                                 # 悬空时落回地面
mcctl.py act escape '{}'                               # 被埋/困在密闭空间时破壳脱身
```

- `eat`：显式 `equip` + `bot.consume()`，**不依赖 `item.foodPoints`**（依赖它会"调用了但没吃"）。返回 `gained.food/health` 证明真的吃进去了。食物为 0 会持续掉血，别拖。
- `fly`：**`/fly` 是切换不是设置**，所以本动作会读服务器回执判断状态，只在需要时发送，返回 `toggled` 说明是否真的发过。注意它**不会**去改物理重力（改了会永久悬空）。
- `flyTo`：先破壳（把自己周围挖出 2 格空气）→ 用 `bot.creative.flyTo` 先上后下 → 恢复重力 → 落点若悬空则找 ±6 格内地表最高处落下。返回 `verticalDelta` 可用于确认真的升/降了。
- `land` / `escape`：分别用于"悬空落不下来"和"被埋在方块里出不去"这两种兜底场景。

## 聊天与插件命令

```bash
mcctl.py act chat '{"message":"你好"}'
mcctl.py act command '{"command":"/home survival","waitMs":5000}'
mcctl.py act setHome '{"name":"survival"}'     # ★ 设置"命名家"并实测验证落点是否安全
mcctl.py act ackChat '{"ids":["abc123"]}'
mcctl.py act ackChat '{"all":true}'
```

`command` 必须以 `/` 开头。插件详情见 `plugins.md`。

### `setHome` 为什么必须单独存在

EssentialsX 的 **`/sethome` 只设置默认家**，而 `/home survival` 用的是**名为 survival 的家**。想改后者必须 `/sethome survival`。只跑 `/sethome` 会让人以为改好了，实际白改——**曾因此造成 37 次死亡的循环**：`survival` 家点被设在了一个地下空洞，每次 `/home survival` 都把机器人传送进地下，被杀、重生、再传送。

`setHome` 会：先 `/sethome <name>`（失败则退回默认 `/sethome`）→ **真的执行一次 `/home <name>` 验证落点** → 检查脚下是否实心、头脚两格是否空气 → 返回 `PASS/FAIL`。**只看"已将你当前的位置设置为家"这句话是不够的**，那句话在设置默认家时也会出现。

主人说的话由执行器放进 `memory.chatQueue`；**外置大脑**（`friday-brain.js`）每轮读取并在处理完后用 `ackChat` 标记已消费，避免重复响应同一条指令。

