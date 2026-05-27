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
- **Commands:** `cli/commands/{up,init,build,eject,clean,doctor}.ts` — six subcommands dispatched
  from `main.ts`.
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
