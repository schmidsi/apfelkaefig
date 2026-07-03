<p align="center">
  <img src="assets/logo.svg" alt="apfelkäfig" width="420">
</p>

# apfelkäfig

Disposable dev sandboxes on Apple Silicon, safe to point coding agents at. `akf up` boots a project
inside an Apple-`container` micro-VM with Claude Code (or any CLI agent) running with
`--dangerously-skip-permissions`. **The VM is the sandbox**, so the permission prompts are
redundant, not risky.

Pre-release (v0.2). macOS / Apple Silicon only.

## Install

From source (Deno 1.41+):

```bash
git clone https://github.com/schmidsi/apfelkaefig
cd apfelkaefig
deno task compile
cp dist/akf /usr/local/bin/akf
```

Homebrew and npm are planned — see [`TODO.md`](TODO.md).

## Use

Drive-by from any directory — no setup:

```bash
akf up                         # interactive Claude inside the built-in image
akf up bash                    # drop into a shell
akf up -- claude --resume      # forward args to the in-container command
akf clean                      # leave no trace
```

For projects you'll come back to, `akf init` writes a `.apfelkaefig.json` + marker blocks.

## Three project tiers

Pick the lightest shape that fits; promote when you outgrow it.

1. **drive-by** — no files in the repo. `akf up` runs from any directory with built-in defaults.
2. **akf-native** — `.apfelkaefig.json` at the repo root. JSONC, versioned, with a
   [published schema](https://apfelkaefig.com/schema/v1.json) for IDE autocomplete.
3. **devcontainer-native** — `.devcontainer/devcontainer.json`. Plays with VS Code Dev Containers,
   Codespaces, Coder. Reach for it when you need the dev-container ecosystem.

`akf init` writes tier 2 (or tier 3 with `--advanced`). `akf eject --devcontainer` promotes 2 → 3;
`akf eject --bash` writes standalone `start.sh` + `build.sh`. Eject is one-way.

## Config

```jsonc
// .apfelkaefig.json
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1,

  // Defaults to the built-in base (built locally on first `akf up`, cached as
  // apfelkaefig-base:<hash>). Set a registry tag, or build locally:
  // "image": { "dockerfile": ".devcontainer/Dockerfile" },

  // Use a per-project ~/.claude — handy when you juggle multiple Claude accounts.
  // Default: "~/.claude". Container target stays /home/<user>/.claude.
  // "claudeConfigDir": "~/.claude-work",

  // Run the command inside a shared tmux session so a second `akf up` from
  // another terminal attaches to the *same* running container instead of
  // starting a new one. Needs tmux in the image (the built-in base has it).
  // Default: false.
  // "tmux": true,

  "env": { "TZ": "UTC" },
  "command": ["claude", "--dangerously-skip-permissions"]
}
```

JSONC: comments and trailing commas allowed. Unknown top-level keys are a hard error — promote to
`.devcontainer/devcontainer.json` (tier 3) when you outgrow the schema.

### Parallel sessions in one container (`tmux`)

With `"tmux": true` (or the `akf up --tmux` flag — handy for tier-3 `devcontainer.json` projects that
can't set the config key), the first `akf up` starts the container and drops you into a tmux session
named `akf`. Running `akf up --tmux` again from another terminal (same project) doesn't start a
second box — it `container exec`s into the running one and attaches to that session, so every terminal
shares the same filesystem, volumes, and tools. `Ctrl+B c` opens a new window (another Claude),
`Ctrl+B d` detaches without stopping the container. The first terminal owns the lifecycle: when it
exits, the container is torn down.

This matters most for projects with **named-volume mounts** (e.g. a devcontainer that persists bash
history or `~/.claude` in a volume): Apple `container` attaches a named volume to only one running VM
at a time, so a plain second `akf up` would fail to bootstrap. tmux mode is the fix — it reuses the
one container instead of starting a rival that can't claim the volumes.

The no-CLI manual setup lives in [`SKILL.md`](SKILL.md) — a Claude Code skill that drops the same
scaffold by hand.

## Requirements

- macOS on Apple Silicon
- [Apple `container`](https://github.com/apple/container) 1.0 or newer — custom `Dockerfile` builds
  go straight through `container build` (no Docker needed).

`akf doctor` checks the above and only complains about 1Password when the active config needs it.

## Why

Coding agents stop every few turns to ask permission. `--dangerously-skip-permissions` is only safe
when the agent runs inside a VM whose only writable mounts are the workspace and `~/.claude` — which
is what apfelkäfig sets up. See [`docs/notes/positioning.md`](docs/notes/positioning.md) for the
competitive landscape and [`docs/notes/architecture.md`](docs/notes/architecture.md) for design
notes.

## Security model

The VM is the trust boundary. Inside it, the agent can read/write the project folder and your
**entire `~/.claude`** (memories, MCP configs, login tokens — drop the mount if that bothers you),
and reach the public internet on any port. It cannot touch anything else on your host; `~/Downloads`
and `~/Desktop` are read-only mounts.

Sandboxing limits local blast radius, not network egress — anything the agent can read it can also
send out.

### Secrets

The base image ships with the 1Password CLI (`op`); `akf up` injects `OP_SERVICE_ACCOUNT_TOKEN` from
your env or macOS keychain so secrets can be resolved on demand with `op read`. See
[`docs/secrets.md`](docs/secrets.md) for the full pattern and threat model.

Found a security issue? Open a GitHub issue or email the address in `git log`.

## Develop

```bash
deno task test       # unit tests for config, container, secrets, fs
deno task dev up     # run from source
deno task compile    # build ./dist/akf (always macOS arm64, even from inside the container)
deno task fmt        # format
deno task lint       # lint
```

## License

MIT
