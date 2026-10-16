# Friday-AI: Minecraft Autonomous Agent

Friday-AI 是一个基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 与大语言模型（LLM）双层架构驱动的高自主性 Minecraft 生存与采矿代理。

## 架构概览

- **执行层 (`scripts/mc-agent.js`)**：
  - 基于 Node.js + Mineflayer 运行，提供精细的环境感知与物理执行 API。
  - 支持原子化动作与流水线调用（`pipeline`）：包括安全分段下潜（`digStair`）、鱼骨分枝采矿（`branchMine`）、智能工具匹配与自动照明防怪。
  - 内置防卡死看门狗、门碰撞体积修正与实体状态保底机制。
- **决策层 (`scripts/friday-brain.js`)**：
  - 基于 LLM（如 GPT-4o / GPT-5.x）进行自主目标规划、 Reflexion 错误反思与流水线决策。
  - 动态读取外部引导任务通道（`task.txt`），支持多层级反思记忆与重试抑制（避免无限死循环）。
- **控制层 (`scripts/mcctl.py`)**：
  - 提供 CLI 命令行工具，支持快速执行观察、探查与单步调试。

## 快速开始

1. **环境准备**：
   - Node.js >= 18
   - Python >= 3.8
   - Mineflayer 及其周边生态库（`mineflayer-pathfinder` 等）

2. **配置说明**：
   - 参考 `references/config.example.json` 创建你的配置文件：
   ```json
   {
     "host": "mc.example.com",
     "port": 25565,
     "username": "FridayAI",
     "auth": "offline",
     "authmePassword": "YOUR_PASSWORD",
     "apiPort": 8765,
     "apiToken": "YOUR_SECURE_TOKEN",
     "masters": ["your_minecraft_username"],
     "llmBaseURL": "https://api.openai.com/v1",
     "llmModel": "gpt-4o",
     "llmApiKey": "sk-YOUR_API_KEY_HERE"
   }
   ```

3. **启动流程**：
   ```bash
   # 启动执行器 API 服务
   node scripts/mc-agent.js config.json

   # 启动自主大脑决策循环
   node scripts/friday-brain.js config.json
   ```

## 目录结构

- `SKILL.md`: 核心 Skill 指南与控制规范说明。
- `scripts/`:
  - `mc-agent.js`: Mineflayer 客户端与执行器 HTTP API。
  - `friday-brain.js`: 自主决策外置大脑。
  - `mcctl.py`: 命令行控制脚本。
- `references/`:
  - `actions.md`: 动作协议与参数全览。
  - `plugins.md`: 常见插件命令兼容参考。
  - `config.example.json`: 配置文件模版。
