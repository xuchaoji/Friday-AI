# AuthMe、EssentialsX、Residence 命令参考

插件版本、语言包和权限会改变命令与回执。未知时先发送帮助命令并观察聊天，不要连续盲试。

## AuthMe Reloaded

- 登录：`/login <密码>` 或 `/l <密码>`
- 首次注册：`/register <密码> <密码>`
- 修改密码：`/changepassword <旧密码> <新密码>`（仅用户明确要求时）
- 注销：`/logout`

执行器会在出生后自动 `/login`，只有配置 `authmeAutoRegister: true` 才会自动注册。密码只能放在权限为 `600` 的配置文件中；禁止把密码发进普通聊天、日志或回答。

## EssentialsX

常用命令：

- `/home [名称]`：回家；可能有传送前摇，执行后停止移动并观察坐标是否突变。
- `/sethome [名称]`：设置家；这是持久性修改，必须得到用户许可。
- `/spawn`：回出生点。
- `/tpa <玩家>`、`/tpaccept`、`/tpdeny`：传送请求。
- `/msg <玩家> <消息>`、`/r <消息>`：私聊。
- `/warp <名称>`、`/warps`：公共传送点。
- `/back`：返回上一个位置；死亡后使用前要考虑掉落物和再次遇险。
- `/kit [名称]`、`/kits`：领取套装；可能有冷却。
- `/balance` 或 `/bal`、`/pay <玩家> <金额>`：经济操作；付款必须用户明确授权。

传送纪律：发送传送命令后立刻 `stop`，至少观察 3–10 秒；移动或受伤可能取消传送。失败时读取服务器消息，不要无限重发。

## Residence（res）

不同版本子命令略有差异，优先 `/res ?`、`/res help`、`/res info` 探测。

常见命令：

- `/res info [领地]`：查看当前位置或指定领地信息。
- `/res current`：显示当前位置领地（部分版本）。
- `/res list`：列出自己的领地。
- `/res tp <领地>`：传送到领地。
- `/res sublist <领地>`：查看子领地。
- `/res pset <领地> <玩家> <权限> true|false|remove`：设置玩家权限。
- `/res set <领地> <权限> true|false|remove`：设置全局权限。
- `/res create <名称>`、`/res remove <名称>`：创建/删除领地，属于高影响操作，必须用户明确授权。

常见权限旗标（实际名称以服务器帮助为准）：`build`、`destroy`、`place`、`use`、`container`、`move`、`tp`、`animalkilling`、`mobkilling`、`pvp`。

进入他人领地后：若破坏/放置命令失败，立即停止，不要用替代手段绕过保护。AI 只能在用户拥有或明确授权的区域挖掘、砍树、放置和开容器。

## 命令调用示例

```bash
MCCTL=/root/.dsh/skills/minecraft-ai-operator/scripts/mcctl.py
$MCCTL act command '{"command":"/home","waitMs":5000}'
$MCCTL act command '{"command":"/res info","waitMs":1200}'
$MCCTL act command '{"command":"/warp mine","waitMs":5000}'
```

每次命令后检查返回的 `messages` 与 `observation.self.position`。任何涉及金钱、权限、领地删除、赠送物品或公开发言的动作，先向用户确认。
