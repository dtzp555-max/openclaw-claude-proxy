#!/bin/bash
# Start openclaw-claude-proxy if not already running
PORT=${CLAUDE_PROXY_PORT:-3456}
if ! lsof -i :$PORT -sTCP:LISTEN &>/dev/null; then
  unset CLAUDECODE
  nohup node "/Users/taodeng/.openclaw/projects/claude-proxy/openclaw-claude-proxy/server.mjs" \
    >> "/Users/taodeng/.openclaw/logs/claude-proxy.log" \
    2>> "/Users/taodeng/.openclaw/logs/claude-proxy.err.log" &
  echo "claude-proxy started on port $PORT (pid $!)"
else
  echo "claude-proxy already running on port $PORT"
fi
