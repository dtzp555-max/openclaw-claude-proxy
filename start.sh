#!/bin/bash
# Start claude-proxy if not already running
if ! lsof -i :3456 -sTCP:LISTEN &>/dev/null; then
  unset CLAUDECODE
  nohup /opt/homebrew/bin/node /Users/taodeng/.openclaw/projects/claude-proxy/server.mjs \
    >> ~/.openclaw/logs/claude-proxy.log \
    2>> ~/.openclaw/logs/claude-proxy.err.log &
  echo "claude-proxy started (pid $!)"
else
  echo "claude-proxy already running"
fi
