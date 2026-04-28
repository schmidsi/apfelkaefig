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
IMAGE_NAME="$(basename "$WORKSPACE")-sandbox"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq" >&2
  exit 1
fi

if ! container system status &>/dev/null; then
  container system start
fi

# --- Parse devcontainer.json ---

# Resolve devcontainer variable syntax from stdin to stdout:
#   ${localEnv:VARNAME}             -> value of $VARNAME on host (empty if unset)
#   ${localWorkspaceFolder}         -> $WORKSPACE
#   ${localWorkspaceFolderBasename} -> basename of $WORKSPACE
resolve_vars() {
  local ws_base line var_name var_value
  ws_base=$(basename "$WORKSPACE")
  while IFS= read -r line || [[ -n "$line" ]]; do
    while [[ "$line" =~ \$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
      var_name="${BASH_REMATCH[1]}"
      var_value="${!var_name:-}"
      line="${line//\$\{localEnv:$var_name\}/$var_value}"
    done
    line="${line//\$\{localWorkspaceFolder\}/$WORKSPACE}"
    line="${line//\$\{localWorkspaceFolderBasename\}/$ws_base}"
    printf '%s\n' "$line"
  done
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

# Build env flags from .containerEnv (always-set) and .remoteEnv (forwarded from host).
# remoteEnv values resolve via ${localEnv:VAR}; skip any whose host value is empty so we
# don't clobber container-side defaults with empty strings.
env_flags=()

while IFS='=' read -r key value; do
  [[ -z "$key" ]] && continue
  value=$(printf '%s' "$value" | resolve_vars)
  env_flags+=(-e "$key=$value")
done < <(jq -r '.containerEnv // {} | to_entries[] | "\(.key)=\(.value)"' "$DEVCONTAINER")

while IFS='=' read -r key value; do
  [[ -z "$key" ]] && continue
  value=$(printf '%s' "$value" | resolve_vars)
  [[ -z "$value" ]] && continue
  env_flags+=(-e "$key=$value")
done < <(jq -r '.remoteEnv // {} | to_entries[] | "\(.key)=\(.value)"' "$DEVCONTAINER")

# Remote user
remote_user=$(jq -r '.remoteUser // "node"' "$DEVCONTAINER")

# Workspace folder
workspace_folder=$(jq -r '.workspaceFolder // "/workspace"' "$DEVCONTAINER")

exec container run -it --rm \
  --cpus 2 --memory 4G \
  "${mount_flags[@]}" \
  "${env_flags[@]}" \
  -u "$remote_user" -w "$workspace_folder" \
  "$IMAGE_NAME" \
  claude --dangerously-skip-permissions "$@"
