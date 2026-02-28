# Project Template

An opinionated project template for running Claude Code in a sandboxed Apple container with browser control.

## What's Included

- **Apple Container setup** — Dockerfile + launch script for running Claude Code in an isolated VM via [Apple Virtualization Framework](https://github.com/apple/container)
- **Chrome forwarding** — CDP proxy so Claude can control a Chrome browser on the host from inside the container
- **Claude configuration** — Pre-configured permissions, MCP servers, and project instructions

## Quick Start

### 1. Install Apple Container

Download from [GitHub releases](https://github.com/apple/container/releases), then:

```bash
container system start
```

### 2. Build the container image

```bash
container build -t claude-sandbox .
```

### 3. Start Chrome with remote debugging (optional, for browser control)

```bash
./scripts/launch-chrome-debug.sh
```

### 4. Launch Claude Code

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
./start.sh
```

## How It Works

### Sandboxing

The Apple container runs a lightweight Linux VM with:
- 2 CPUs, 4GB RAM
- Your project mounted at `/workspace`
- Claude config mounted from `~/.claude`
- Read-only access to `~/Downloads`
- Claude Code runs with `--dangerously-skip-permissions` (safe because the VM is the sandbox)

### Browser Control

The Chrome forwarding setup lets Claude automate a browser through Playwright MCP:

1. `launch-chrome-debug.sh` starts Chrome with `--remote-debugging-port=9222` on localhost
2. A Node.js proxy on port 9223 bridges the container-to-host network gap by rewriting Host headers (Chrome rejects non-localhost connections)
3. Playwright MCP inside the container connects to `host.docker.internal:9223`

### Claude Configuration

- **CLAUDE.md** — Project-level instructions for Claude
- **.claude/settings.local.json** — Allowed/denied permissions (safe git ops, no force push, no `browser_install`)
- **.mcp.json** — Playwright MCP server pointing at the CDP proxy

## Customizing

1. Edit `CLAUDE.md` with your project-specific instructions
2. Add/remove permissions in `.claude/settings.local.json`
3. Add more MCP servers to `.mcp.json`
4. Adjust CPU/memory in `start.sh`
5. Add project dependencies to the `Dockerfile`
