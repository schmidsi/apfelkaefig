---
name: apfelkaefig-sandbox
description: Set up an Apple `container` micro-VM sandbox for running Claude Code (or any coding agent) against an existing project, without installing the `akf` CLI. Use when a user wants the sandbox but is hesitant to install a third-party binary, or when they want to understand exactly what `akf init` would do before running it.
---

# Manual setup: Apfelkäfig sandbox

This is the no-CLI version of `akf init`. Follow these steps to drop the sandbox into any existing
project folder by hand. The end result is identical to running `akf init` — six files created or
appended, then `./build.sh` and `./start.sh` to launch.

## What you get

A disposable Apple-`container` micro-VM, with your project mounted at `/workspace`, that runs Claude
Code with `--dangerously-skip-permissions`. **The VM is the sandbox** — the agent can't touch
anything outside the mounts, so the skipped permission prompts are redundant, not risky.

## Prerequisites

- macOS on Apple Silicon
- [Apple `container`](https://github.com/apple/container) v0.9 or newer
- Docker — only for `build.sh`, until Apple fixes the builder's DNS bug

## Steps

Run from the root of the project you want to sandbox.

### 1. Create `.devcontainer/Dockerfile`

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl sudo ca-certificates jq \
    ripgrep fd-find tree vim unzip \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/latest/download/gh_$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//')_linux_${ARCH}.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local

# Non-root user
RUN useradd -m -s /bin/bash node

# Install Claude Code (as node user so auto-update works)
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:$PATH"

USER root
WORKDIR /workspace
```

### 2. Create `.devcontainer/devcontainer.json`

```json
{
  "name": "${localWorkspaceFolderBasename}",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "remoteUser": "node",
  "mounts": [
    "source=${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind",
    "source=${localEnv:HOME}/Downloads,target=/home/node/Downloads,type=bind,readonly"
  ],
  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/node/.claude"
  },
  "workspaceMount": "source=${localWorkspaceFolder},target=/workspace,type=bind,consistency=delegated",
  "workspaceFolder": "/workspace"
}
```

### 3. Create `start.sh` (mark executable: `chmod +x start.sh`)

```bash
#!/bin/bash
# Start Claude Code inside an Apple container (Apple Virtualization Framework).
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
```

### 4. Create `build.sh` (mark executable: `chmod +x build.sh`)

Builds with Docker and shuttles the image through a local registry — workaround for Apple
`container` v0.9's build-time DNS bug.

```bash
#!/bin/bash
set -e

IMAGE_NAME="claude-sandbox"
REGISTRY="localhost:5555"

echo "Building image with Docker..."
docker build -t "$IMAGE_NAME" .devcontainer/

echo "Starting local registry..."
docker run -d --rm --name registry -p 5555:5000 registry:2

echo "Pushing to local registry..."
docker tag "$IMAGE_NAME" "$REGISTRY/$IMAGE_NAME"
docker push "$REGISTRY/$IMAGE_NAME"

echo "Pulling into Apple Container..."
container image pull --scheme http "$REGISTRY/$IMAGE_NAME"
container image tag "$REGISTRY/$IMAGE_NAME" "$IMAGE_NAME"

echo "Stopping registry..."
docker stop registry

echo "Done. Image '$IMAGE_NAME' is ready for Apple Container."
echo "Run ./start.sh to launch."
```

### 5. Append to `.gitignore`

```
# >>> akf >>>
.akf/
dist/akf
# <<< akf <<<
```

### 6. Append to `CLAUDE.md` (create the file if missing)

```markdown
<!-- akf:start -->
## Sandbox (apfelkäfig)

This folder is set up to run inside an Apple `container` micro-VM. Claude Code is launched with
`--dangerously-skip-permissions` — **the VM is the sandbox**, so the permission prompts are
redundant.

Launch:

1. `./build.sh` — build the sandbox image (one-time; rebuild when the Dockerfile changes).
2. `./start.sh` — start Claude Code inside the sandbox.

The sandbox mounts this folder at `/workspace`, `$HOME/.claude` read-write, and `$HOME/Downloads`
read-only.
<!-- akf:end -->
```

## Launch

```bash
./build.sh    # one-time; rebuild when Dockerfile changes
./start.sh    # launch Claude Code inside the sandbox
```

## Notes

- The marker blocks (`# >>> akf >>>` / `<!-- akf:start -->`) exist so a future `akf update` can
  rewrite just the managed region without clobbering your hand edits.
- `~/.claude` is mounted read-write, so Claude inside the VM shares your login and MCP config with
  the host. If you'd rather isolate, drop that mount line and run `claude login` inside the VM.
- Apple `container`'s networking is still rough in v0.9 — localhost port forwarding doesn't work on
  the Apple path. For browser-driven dev, see the `assets/chrome-bridge/` scripts in the apfelkäfig
  repo (CDP proxy on :9223).
- For IDE integration (VS Code / Cursor, `/ide` in Claude Code, inline diffs), open the folder
  and pick **Reopen in Container** — the `.devcontainer/` files above are all Dev Containers
  needs. The editor server runs inside the VM, so `/ide` connects on loopback without any host
  port forwarding. `./start.sh` remains the right path for pure terminal agent sessions.
