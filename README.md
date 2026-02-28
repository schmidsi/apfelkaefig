# Claude in an Apple

Scaffold a Claude Code project with Apple container sandboxing and Chrome browser control.

```bash
npx create-claude-in-an-apple my-app
```

Or equivalently:

```bash
npm init claude-in-an-apple my-app
```

## What You Get

```
my-app/
├── .claude/settings.local.json   # Permissions (safe git ops, deny force push)
├── .mcp.json                     # Playwright MCP → Chrome CDP proxy
├── CLAUDE.md                     # Project instructions for Claude
├── Dockerfile                    # Apple container image
├── start.sh                      # Launch Claude Code in the container
└── scripts/
    └── launch-chrome-debug.sh    # Chrome + CDP proxy on the host
```

## Prerequisites

- macOS with Apple Silicon
- [Apple Container](https://github.com/apple/container) installed
- Node.js (for `npx` and the Chrome CDP proxy)

## Quick Start

```bash
# Scaffold
npx create-claude-in-an-apple my-app
cd my-app

# Build the container image
container build -t claude-sandbox .

# (Optional) Start Chrome with remote debugging for browser control
./scripts/launch-chrome-debug.sh

# Launch Claude Code
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

## Customizing

1. Edit `CLAUDE.md` with your project-specific instructions
2. Add/remove permissions in `.claude/settings.local.json`
3. Add more MCP servers to `.mcp.json`
4. Adjust CPU/memory in `start.sh`
5. Add project dependencies to the `Dockerfile`

## License

MIT
