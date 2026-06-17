# Apfelkäfig

Sandboxed dev environment built on Apple's native `container` CLI. Disposable, hermetic dev shells
on Apple Silicon, also safe to point coding agents at (Claude Code, Codex, Gemini CLI). **Dual-use,
dev-first.**

## Scope

The primary user of this project is me. Making it usable for other people is nice, but not a
priority. Optimize decisions for "works on Simon's machine, ships fast" over "polished for
strangers." Distribution surfaces (Homebrew, npm, ghcr.io publishing) are deferred until they pay
for themselves.

## Repo orientation

- **Language:** Deno + TypeScript. Entry point `cli/main.ts`.
- **Commands:** `cli/commands/{up,init,build,eject,clean,doctor,plugin,statusline}.ts` — eight
  subcommands dispatched from `main.ts`.
- **Config schema:** `schema/v1.json` (JSON Schema Draft 7). `.apfelkaefig.json` is JSONC; unknown
  top-level keys are a **hard error** — promote to `.devcontainer/devcontainer.json` (tier 3) when
  you outgrow the schema.
- **Templates:** `templates/` (rendered by `akf init` / `akf eject`).
- **Base image:** `image/Dockerfile`, embedded into the compiled binary via
  `deno compile --include`.
- **Tests:** `deno task test`. Build: `deno task compile` → `dist/akf`. Dev: `deno task dev <args>`.

## Conventions

- **Three-tier model** (drive-by / akf-native / devcontainer-native — see README) shapes feature
  scope. Decide which tier a change belongs to before adding code.
- **Marker-managed blocks** must be re-rendered idempotently by `akf init`, never hand-merged:
  `<!-- akf:start -->` / `<!-- akf:end -->` in this file, `# >>> akf >>>` / `# <<< akf <<<` in host
  `.gitignore`.
- **Never touch `settings.local.json`** from `akf init` — `--dangerously-skip-permissions` makes it
  dead config, and merging into it breaks user edits.

## Where things live

- `README.md` — user-facing docs.
- `TODO.md` — un-shipped surfaces (npm, brew, ghcr.io, CI, demo).
- `tasks/00X_*.md` — detailed implementation plans (current and historical).
- `docs/notes/` — frozen design history (`positioning.md`, `architecture.md`).
- `docs/secrets.md` — 1Password integration detail.

<!-- akf:start -->

## Sandbox (apfelkäfig)

This folder is set up to run inside an Apple `container` micro-VM. Claude Code is launched with
`--dangerously-skip-permissions` — **the VM is the sandbox**, so the permission prompts are
redundant.

Launch:

1. `akf up` — first run builds the embedded base image (one-time, ~minute or two), then starts
   Claude Code inside the sandbox. Subsequent runs reuse the cached image.

Configured via `.apfelkaefig.json` at the repo root. The sandbox mounts this folder at
`/workspaces/apfelkaefig`, `$HOME/.claude` read-write, and `$HOME/Downloads` and `$HOME/Desktop`
read-only.

<!-- akf:end -->

<!-- akf plugin: ssh start -->
## SSH access to the sandbox

This project enables the akf `ssh` plugin. Run:

```bash
akf up --serve --rebuild   # first run after enabling/changing the plugin
akf up --serve             # subsequent runs
```

The first `--serve` after adding or changing this plugin needs `--rebuild`
(or a prior `akf build`): the sshd entrypoint is baked into the image at build
time, and `akf up` reuses the cached image otherwise — without the rebuild you
get `failed to find target executable /usr/local/bin/akf-sshd`.

That starts sshd inside the sandbox in the foreground (Ctrl+C stops it) and
prints the connection details. In the desktop app's "Add SSH connection" use
the printed Host / Port / Identity — the app runs the agent inside this box
over SSH.

Reachability is local-only: the port is published on `127.0.0.1`, and the
host key persists across runs so reconnects don't trip `known_hosts`.

### Troubleshooting the desktop attach

- **"Failed to connect to agent"** — your SSH keys are served by the **1Password
  SSH agent**, which stops responding ("connection refused") whenever 1Password
  is locked or closed. The desktop app surfaces that as this error. Fix: open and
  unlock 1Password, then "Try again". (Lengthen Settings → Security → auto-lock if
  it keeps happening.)
- **"All configured authentication methods failed"** — the key the app offers
  isn't in the sandbox's `authorized_keys`. `authorizedKey` must point at a file
  holding the public key the app's agent serves (here: the 1Password keys in the
  gitignored `.devcontainer/authorized_keys.pub`).
- **"Failed to start remote server" / "claude-ssh: timeout"** — `claude` not on
  the non-interactive PATH; the entrypoint symlinks it into `/usr/local/bin`.
- **"chmod socket: invalid argument"** (in `~/.claude/remote/run/<id>/remote-server.log`)
  — `~/.claude/remote` landed on virtiofs (the host mount), which rejects chmod on
  socket inodes. A native named volume shadows that subdir to fix it.

Diagnose from the host with `container logs akf-serve-<projectSlug>` (sshd auth)
and, inside the box, `~/.claude/remote/run/<id>/remote-server.log` (daemon).
<!-- akf plugin: ssh end -->
