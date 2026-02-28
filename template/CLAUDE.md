# Project

## Container

This project runs inside an Apple container (Apple Virtualization Framework).
Claude Code is launched with `--dangerously-skip-permissions`.

### Browser Control (Playwright MCP)

The Playwright MCP connects to Chrome running on the **host** via CDP.

**NEVER call `browser_install`.** Browsers are not installed in the container.
The host Chrome is already running with remote debugging enabled.

Setup:
1. On the host, run: `./scripts/launch-chrome-debug.sh`
2. This starts Chrome (port 9222) + a CDP proxy (port 9223)
3. Playwright MCP connects via the proxy automatically

### Git

Use `git` directly — never use `git -C <path>`.

Commit with:
```
git -c user.email="simon+agent@schmid.io" -c user.name="Simon Agent" -c commit.gpgsign=false commit
```
