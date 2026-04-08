# Apfelkäfig

Sandboxed dev environment built on Apple's native `container` CLI. Disposable,
hermetic dev shells on Apple Silicon, also safe to point coding agents at
(Claude Code, Codex, Gemini CLI). **Dual-use, dev-first.** See `POSITIONING.md`
for the full naming/strategy brainstorm.

## Status

Pre-code. The repo currently holds the leftover `create-claude-in-an-apple`
npx scaffolder from a prior iteration — to be reworked, not extended. Next
session is an architecture session, not implementation.

## Decisions made (2026-04-08 session)

- **Brand:** Apfelkäfig. ASCII `apfelkaefig`. Domain acquired, GitHub org
  `ApfelKaefig` exists but empty.
- **Binary name:** `akf` (three keystrokes, `gh`/`kubectl` pattern). Homebrew
  formula will be `apfelkaefig` installing binary `akf`.
- **Repo:** `ApfelKaefig/apfelkaefig` (monorepo until it hurts). This folder
  becomes that repo. Likely a clean history reset rather than carrying the
  prior `create-claude-in-an-apple` commits.
- **Implementation language: Deno** (most probably — to be confirmed in the
  architecture session). Earlier discussion considered Go; user pushed back
  toward Deno. Revisit trade-offs (single-binary `deno compile`, Homebrew
  packaging, shelling out to `container`, reusing the existing Node CDP proxy)
  at the start of next session.

## Open for next session (architecture)

- **Reconcile the two framings.** The "npx scaffolder" (current code) and the
  "`akf` CLI that manages envs" framings are *not* in contradiction per the
  user — they're different applications of the same underlying tools. Figure
  out the shared core and how both surfaces sit on top of it. Do not assume
  the scaffolder gets thrown away.
- Final call on Deno vs alternatives.
- Repo layout once language is locked.
- How to handle Apple `container` v0.9 networking bugs (port forwarding,
  build-time networking). Read `emarc/claude-contained` source before
  rediscovering their gotchas.
- `akf doctor` and minimum `container` version pinning.

## What's worth keeping from the current scaffold

- `template/scripts/launch-chrome-debug.sh` + the Node CDP proxy on :9223 —
  rewrites Host headers so the container can drive host Chrome via
  `host.docker.internal:9223`. This is a real, hard-won workaround for an
  Apple-`container` networking gotcha and is the hidden crown jewel. **Do not
  lose this when restructuring.**
- `template/Dockerfile`, `template/start.sh` mount layout (`/workspace`,
  `~/.claude` mount, RO `~/Downloads`, `--dangerously-skip-permissions` under
  the VM-is-the-sandbox model).
- `template/CLAUDE.md`, `template/.mcp.json`, `template/.claude/settings.local.json`
  as starting defaults for whatever the scaffolder surface becomes.

## Throw away / rework

- `bin/create.mjs`, root `package.json`, root `README.md` — all branded for
  `create-claude-in-an-apple`. Rework once language + architecture decided.

## Competitive notes (see POSITIONING.md for detail)

- Only direct competitor: `emarc/claude-contained` (dual-mode Docker / Apple
  `container`; no localhost port forwarding on the Apple path). Read their
  source before writing the wrapper layer.
- Docker Sandboxes (March 2026) validated the category but is cross-platform
  Docker — our moat is being native to Apple Silicon with no Docker Desktop
  tax.
- Apple `container` is pre-1.0 (v0.9, Feb 2026). First-mover window is now.
