# apfelkäfig

Disposable dev sandboxes on Apple Silicon, safe to point coding agents at.

`akf init` drops a one-command Apple-`container` sandbox into any existing project folder — build
the image, launch Claude Code inside the micro-VM, and stop babysitting permission prompts. **The VM
is the sandbox**, so Claude runs with `--dangerously-skip-permissions` without risk to the host.

Status: pre-release (v0.1 MVP). macOS / Apple Silicon only.

## Try it without installing anything

Don't want to install a third-party binary before you know what it does? Read **[SKILL.md](SKILL.md)** —
the same scaffold, step by step, as six files you paste into your project by hand. `akf init` just
automates that.

You can also drop `SKILL.md` into `~/.claude/skills/apfelkaefig/` and let Claude Code run the setup
for you.

## Install

Not packaged yet. Build from source:

```bash
git clone https://github.com/ApfelKaefig/apfelkaefig
cd apfelkaefig
deno task compile
cp dist/akf /usr/local/bin/akf
```

Requires [Deno](https://deno.com) 1.41+ to build. The compiled `akf` is self-contained — no runtime
dependency on Deno or Node.

## Use

```bash
cd ~/code/my-project
akf init      # augments the folder (non-destructive; idempotent)
./build.sh    # build the sandbox image (one-time)
./start.sh    # launch Claude Code inside the sandbox
```

`akf init` adds six things:

- `.devcontainer/Dockerfile` + `devcontainer.json` — image definition, also picked up by VSCode Dev
  Containers.
- `start.sh` — launches Apple `container` with your folder at `/workspace`, `$HOME/.claude`
  read-write, `$HOME/Downloads` read-only.
- `build.sh` — builds with Docker and shuttles the image through a local registry (workaround for
  Apple `container` v0.9's build-time DNS bug).
- Marker-delimited blocks appended to `.gitignore` and `CLAUDE.md`.

Existing files are never overwritten. Re-running `akf init` is a no-op.

## Requirements

- macOS on Apple Silicon
- [Apple `container`](https://github.com/apple/container) — tested on v0.9
- Docker — only for `build.sh`, until Apple fixes the builder's DNS bug

## Why

Claude Code and other coding agents stop every few turns to ask permission for Bash commands, file
writes, or WebFetch domains. `--dangerously-skip-permissions` silences the prompts but only makes
sense when the agent genuinely can't escape — i.e., when it's running inside a VM whose only writable
mounts are the workspace and `~/.claude`. That's what apfelkäfig sets up, using Apple's native
`container` CLI (lightweight VMs, no Docker Desktop tax on Apple Silicon).

See [POSITIONING.md](POSITIONING.md) for the competitive landscape and
[ARCHITECTURE_EXPLORATION.md](ARCHITECTURE_EXPLORATION.md) for the design notes.

## Security model

The VM is the trust boundary. Inside it, Claude runs with every permission prompt disabled —
that's the point. You should understand exactly what the VM can reach before letting an agent
loose in it.

**The agent inside the sandbox can:**

- Read and write everything in the project folder (mounted at `/workspace`).
- Read and write your **entire `~/.claude` directory** — memories, MCP configs, login tokens,
  other projects' settings. This is a deliberate trade-off (so the agent shares your login and
  MCP setup with the host) but it means "sandboxed" does **not** mean "isolated from your Claude
  account." If that bothers you, drop the `~/.claude` mount from `start.sh` and run `claude login`
  inside the VM instead.
- Reach the public internet on any port.

**The agent cannot:**

- Touch anything else on your host — including other project folders, your home directory, or
  shell history.
- Write to `~/Downloads` (read-only mount, so it can read files you drop in but not modify them).

**Not covered:** secret exfiltration via network. Anything the agent can read inside the VM
(including `~/.claude` contents) it can also send to the open internet. Sandboxing limits local
blast radius, not data egress.

Found a security issue? Open a GitHub issue or email the address in `git log`.

## Develop

```bash
deno task test       # unit tests for fs helpers
deno task dev init   # run from source in the current folder
deno task compile    # build ./dist/akf
```

## License

MIT
