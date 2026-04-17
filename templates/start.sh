#!/bin/bash
# Start Claude Code inside an Apple container (Apple Virtualization Framework).
#
# Prerequisites:
#   - Install Apple Container: https://github.com/apple/container
#   - Build the image first:   ./build.sh
#   - jq must be installed:    brew install jq
#
# Mounts and env vars are read from .devcontainer/devcontainer.json
# (single source of truth for both devcontainer and Apple container launches).
#
# Usage:
#   ./start.sh                # interactive Claude Code session
#   ./start.sh "prompt here"  # pass a prompt directly

set -e
WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
DEVCONTAINER="$WORKSPACE/.devcontainer/devcontainer.json"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq" >&2
  exit 1
fi

if ! container system status &>/dev/null; then
  container system start
fi

# --- Parse devcontainer.json ---

# Resolve devcontainer variable syntax:
#   ${localEnv:HOME}              -> $HOME
#   ${localWorkspaceFolder}       -> $WORKSPACE
#   ${localWorkspaceFolderBasename} -> basename of $WORKSPACE
resolve_vars() {
  sed \
    -e "s|\${localEnv:HOME}|$HOME|g" \
    -e "s|\${localWorkspaceFolder}|$WORKSPACE|g" \
    -e "s|\${localWorkspaceFolderBasename}|$(basename "$WORKSPACE")|g"
}

# Build mount flags from .mounts[] and .workspaceMount
mount_flags=()

# Workspace mount
ws_mount=$(jq -r '.workspaceMount // empty' "$DEVCONTAINER" | resolve_vars)
if [[ -n "$ws_mount" ]]; then
  # Extract source and target from the comma-separated string
  ws_source=$(echo "$ws_mount" | sed -n 's/.*source=\([^,]*\).*/\1/p')
  ws_target=$(echo "$ws_mount" | sed -n 's/.*target=\([^,]*\).*/\1/p')
  mount_flags+=(-v "$ws_source:$ws_target")
fi

# Additional mounts
while IFS= read -r mount; do
  mount=$(echo "$mount" | resolve_vars)
  src=$(echo "$mount" | sed -n 's/.*source=\([^,]*\).*/\1/p')
  tgt=$(echo "$mount" | sed -n 's/.*target=\([^,]*\).*/\1/p')
  ro=""
  if echo "$mount" | grep -q 'readonly'; then
    ro=":ro"
  fi
  # Skip mounts whose source doesn't exist on the host
  if [[ ! -e "$src" ]]; then
    echo "Warning: skipping mount $src -> $tgt (source not found)" >&2
    continue
  fi
  mount_flags+=(-v "$src:$tgt$ro")
done < <(jq -r '.mounts[]? // empty' "$DEVCONTAINER")

# Build env flags from .containerEnv
env_flags=()
while IFS='=' read -r key value; do
  value=$(echo "$value" | resolve_vars)
  env_flags+=(-e "$key=$value")
done < <(jq -r '.containerEnv // {} | to_entries[] | "\(.key)=\(.value)"' "$DEVCONTAINER")

# Remote user
remote_user=$(jq -r '.remoteUser // "node"' "$DEVCONTAINER")

# Workspace folder
workspace_folder=$(jq -r '.workspaceFolder // "/workspace"' "$DEVCONTAINER")

exec container run -it --rm \
  --cpus 2 --memory 4G \
  "${mount_flags[@]}" \
  "${env_flags[@]}" \
  -u "$remote_user" -w "$workspace_folder" \
  claude-sandbox \
  claude --dangerously-skip-permissions "$@"
