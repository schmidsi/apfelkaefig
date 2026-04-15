#!/bin/bash
# Start Claude Code inside an Apple container (Apple Virtualization Framework).
#
# Prerequisites:
#   - Install Apple Container: https://github.com/apple/container
#   - Build the image first:   ./build.sh
#
# Usage:
#   ./start.sh                # interactive Claude Code session
#   ./start.sh "prompt here"  # pass a prompt directly

set -e
WORKSPACE="$(cd "$(dirname "$0")" && pwd)"

if ! container system status &>/dev/null; then
  container system start
fi

exec container run -it --rm \
  --cpus 2 --memory 4G \
  -v "$WORKSPACE:/workspace" \
  -v "$HOME/.claude:/home/node/.claude" \
  --mount "type=bind,source=$HOME/Downloads,target=/home/node/Downloads,readonly" \
  -e CLAUDE_CONFIG_DIR=/home/node/.claude \
  -u node -w /workspace \
  claude-sandbox \
  claude --dangerously-skip-permissions "$@"
