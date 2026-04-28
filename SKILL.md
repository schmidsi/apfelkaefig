---
name: apfelkaefig-sandbox
description: Set up an Apple `container` micro-VM sandbox for running Claude Code (or any coding agent) against an existing project, without installing the `akf` CLI. Use when a user wants the sandbox but is hesitant to install a third-party binary, or when they want to understand exactly what `akf init` would do before running it.
---

# Manual setup: Apfelkäfig sandbox

This is the no-CLI version of `akf init` followed by `akf eject --bash`. Two paths, depending on
whether the user wants a tiny config file or full self-contained scripts.

The end result either way: a disposable Apple-`container` micro-VM, with the project mounted at
`/workspaces/<basename>`, that runs Claude Code with `--dangerously-skip-permissions`. **The VM is
the sandbox** — the agent can't touch anything outside the mounts, so the skipped permission prompts
are redundant, not risky.

## Prerequisites

- macOS on Apple Silicon
- [Apple `container`](https://github.com/apple/container) v0.9 or newer
- Docker — only if the project uses a custom `Dockerfile` (until Apple fixes the builder's DNS bug)

## Path A — Tier 2 (akf-native)

Use this when the user is willing to install `akf` later but wants the config in place now, or when
collaborators on the same repo will have `akf` installed.

### Step 1. Create `.apfelkaefig.json`

Reference the file `templates/apfelkaefig.json` in the apfelkäfig repo as the canonical starter.
Minimum content:

```jsonc
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1
}
```

JSONC: comments and trailing commas allowed. Add only the keys you actually need to override —
defaults give you the built-in `ghcr.io/apfelkaefig/base` image, `node` user, workspace at
`/workspaces/<basename>`, and `claude --dangerously-skip-permissions` as the command.

### Step 2. Append `.gitignore` block

```
# >>> akf >>>
.akf/
# <<< akf <<<
```

### Step 3. Append to `CLAUDE.md` (create if missing)

Reference `templates/CLAUDE.block.md` in the apfelkäfig repo for the canonical block — wrap the
contents in `<!-- akf:start -->` / `<!-- akf:end -->` markers so a future tool can rewrite the
managed region without clobbering hand edits.

### Step 4. Run

```bash
akf up
```

## Path B — Self-contained scripts (no akf at runtime)

Use this when the user does not want any third-party binary involved at run time. Equivalent to
`akf init --bash`. Reference `templates/start.sh`, `templates/build.sh`, and
`templates/.devcontainer/` in the apfelkäfig repo as the source of truth — never inline them here,
so they can't drift.

The flow is:

1. Copy `templates/.devcontainer/Dockerfile` and `templates/.devcontainer/devcontainer.json` to the
   project's `.devcontainer/`.
2. Copy `templates/start.sh` and `templates/build.sh` to the project root, `chmod +x` both.
3. Append the same `.gitignore` and `CLAUDE.md` blocks as Path A.
4. Run `./build.sh` (one-time) then `./start.sh`.

## IDE integration (VS Code / Cursor)

If `.devcontainer/` is present (Path B, or Path A with `akf init --advanced`), VS Code and Cursor
pick it up via the Dev Containers extension. Open the folder and choose **Reopen in Container**. The
editor server runs inside the VM, so `/ide` in Claude Code wires up on container-local loopback with
no host port forwarding.

## Notes

- The marker blocks (`# >>> akf >>>` / `<!-- akf:start -->`) exist so a future `akf update` can
  rewrite just the managed region without clobbering hand edits.
- `~/.claude` is mounted read-write, so Claude inside the VM shares your login and MCP config with
  the host. To isolate, drop that mount via a custom config and run `claude login` inside the VM.
- The base image installs the 1Password CLI (`op`); `akf up` injects `OP_SERVICE_ACCOUNT_TOKEN` from
  your env or macOS keychain by default. Use `op read` inside the VM to resolve secrets on demand.
  See `skills/1password-agent-secrets/SKILL.md` for the full pattern.
- Apple `container` networking is rough in v0.9 — localhost port forwarding doesn't work on the
  Apple path. For browser-driven dev, see `assets/chrome-bridge/` in the apfelkäfig repo (CDP proxy
  on :9223).
