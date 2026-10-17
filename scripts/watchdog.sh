#!/bin/bash
# Minecraft AI Operator Lightweight Watchdog
CONFIG="/root/.config/minecraft-ai/config.json"
AGENT_SCRIPT="/root/.dsh/skills/minecraft-ai-operator/scripts/mc-agent.js"
BRAIN_SCRIPT="/root/.dsh/skills/minecraft-ai-operator/scripts/friday-brain.js"

while true; do
  # 1. 检查 mc-agent (执行器)
  if ! pgrep -f "node.*mc-agent.js" > /dev/null; then
    echo "[watchdog $(date -Iseconds)] mc-agent is down! Restarting..."
    nohup node "$AGENT_SCRIPT" "$CONFIG" >> /tmp/mc-agent.log 2>&1 &
    sleep 5
  fi

  # 2. 检查 friday-brain (外置大脑)
  if ! pgrep -f "node.*friday-brain.js" > /dev/null; then
    echo "[watchdog $(date -Iseconds)] friday-brain is down! Restarting..."
    rm -f /root/.config/minecraft-ai/brain.lock
    nohup node "$BRAIN_SCRIPT" "$CONFIG" >> /tmp/friday-brain.log 2>&1 &
    sleep 3
  fi

  # 3. 检查 watchdog 自身单例
  sleep 10
done
