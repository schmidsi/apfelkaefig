# Plan: v0.2 architecture refactor — drive-by mode, schema, eject

## Context

v0.1 delivered `akf init`: a scaffolder that writes `.devcontainer/`, `build.sh`, `start.sh` into a
project so the user can run Claude inside an Apple-`container` micro-VM. It works, but the shape has
aged out of its skin in three ways:

1. **Per-project `build.sh`/`start.sh` is a maintenance vector.** When the scripts evolve (e.g. the
   recent `IMAGE_NAME` collision fix in `a96b899`), every project that ran `akf init` is stuck on
   the old version until manually patched. Today's image-tag bug is the canonical example of
   "copies-of-scripts-drift."
2. **No drive-by mode.** Today, using akf in a repo means committing scripts. There is no path to
   run an ad-hoc sandbox in someone else's repo without leaving traces.
3. **No structured config.** Mounts, env, image, command are all hardcoded in the templated scripts.
   Per-project tweaks force a fork of the scripts.

The fix: make the `akf` binary itself the runtime. Replace per-project shell scripts with a small
versioned config file (`.apfelkaefig.json`). Ship a registry-hosted base image so drive-by "just
works" on a clean machine. Keep the script-writing path as `akf eject` for projects that want
self-contained, akf-free entry points.

This refactor is **breaking** for v0.1 users — their committed `build.sh`/`start.sh` keep working
(they're standalone bash), but the canonical workflow shifts to `akf up`. v0.1 → v0.2 migration is
`akf eject --bash` for users who want to keep the old shape, or `akf init` (rewritten) for the new
shape.

---

## Approach

The architecture from the recent jam, condensed:

**Three project tiers** (linear evolution, audience-defined not complexity-defined):

1. **drive-by** — no files in the repo. `akf up` works from any directory using built-in defaults +
   CLI flags. Leaves no traces.
2. **akf-native** — `.apfelkaefig.json` in the repo root. Versioned, JSONC, published schema.
   Advertises akf usage to collaborators.
3. **devcontainer-native** — `.devcontainer/devcontainer.json` in the repo. Plays with VS Code Dev
   Containers, Codespaces, Coder. More capable than tier 2.

**One mode orthogonal to the tiers: ejected.** `akf eject --bash` writes self-contained `build.sh` +
`start.sh` (no akf needed at runtime). `akf eject --devcontainer` translates `.apfelkaefig.json` →
`.devcontainer/devcontainer.json` (tier 2 → tier 3 promotion). Eject is one-way; coming back is "ask
Claude to inspect this and rewrite the config."

**Config resolution** (deterministic, no merging):

1. `.apfelkaefig.json` if present (walk up from CWD until found or filesystem root / `.git`
   boundary).
2. Else `.devcontainer/devcontainer.json` if present (same walk).
3. Else built-in defaults.
4. CLI flags override whichever resolved.

If both files exist, `.apfelkaefig.json` wins; `akf doctor` warns.

**Built-in base image: embedded Dockerfile (MVP), registry-hosted later.** The `image/Dockerfile` is
embedded into the `akf` binary at compile time via `deno compile --include ./image`. On first
`akf up`, it is materialized into `~/.cache/apfelkaefig/base/<hash>/Dockerfile` and built locally
with Docker; tagged `apfelkaefig-base:<hash>` where `<hash>` is the first 12 hex chars of the
Dockerfile's SHA-256. Cache invalidates automatically when the Dockerfile changes. arm64-only.

This MVP path requires Docker on the host (Apple `container`'s v0.9 builder has DNS bugs that break
apt/curl during build). The original plan of "drive-by needs only Apple `container`, no Docker" is
**deferred** — registry publishing at `ghcr.io/apfelkaefig/base` with a digest baked into the binary
will land later. `AKF_BASE_IMAGE=<ref>` overrides the embedded path for development. See
`image/README.md` for the full state.

**Image scope (kept minimal):** Debian slim + claude + git + node + jq + ripgrep + curl + fd-find +
tree + vim + gh. Codex, Gemini CLI, Python, etc. are BYO via custom Dockerfile
`FROM ghcr.io/apfelkaefig/base`.

**Workspace path** moves to `/workspaces/${localWorkspaceFolderBasename}` (devcontainer convention).
Improves `pwd` legibility — you can tell which sandbox you're in.

**1Password integration: implicit-on with override.** If `OP_SERVICE_ACCOUNT_TOKEN` is in the macOS
keychain (with the 128-char workaround), akf injects it into the container env. `op read` inside the
container is load-bearing — keep it. Override via `secrets.onepassword: false` in config or
`AKF_DISABLE_OP=1` env var. If config explicitly sets `onepassword: true` and the token is missing,
**error** (don't silently degrade — security is top concern).

**Three distribution surfaces, one codebase:**

- **CLI** (canonical): `akf` binary compiled by `deno compile`, distributed via Homebrew.
- **npm** (`apfelkaefig`): postinstall downloads the matching `akf-darwin-arm64` binary from the
  GitHub release. ~50 lines of glue. `npx apfelkaefig …` runs the same binary as `akf …`, so zero
  drift.
- **skill** (`SKILL.md`): markdown procedure that points Claude at `templates/` and tells it what to
  write. References templates by path — never inlines them — so it can't drift either.

`templates/` is the shared source of truth. Drive-by, simple, advanced, eject — they all read from
the same template files.

### Repo layout after refactor

```
apfelkaefig/
├── deno.json
├── cli/                              # was src/
│   ├── main.ts
│   ├── commands/
│   │   ├── up.ts                     # NEW — canonical entry point
│   │   ├── build.ts                  # NEW — wraps the Docker→registry shuttle
│   │   ├── init.ts                   # REWRITTEN — writes .apfelkaefig.json
│   │   ├── eject.ts                  # NEW — --devcontainer | --bash
│   │   ├── doctor.ts
│   │   └── clean.ts                  # NEW — teardown for drive-by users
│   └── lib/
│       ├── fs.ts                     # existing helpers
│       ├── markers.ts
│       ├── config.ts                 # NEW — resolution chain (find/parse/validate)
│       ├── schema.ts                 # NEW — TS types matching schema/v1.json
│       ├── container.ts              # NEW — wraps `container run`/`pull`/`stop`
│       ├── registry.ts               # NEW — local :5555 registry lifecycle
│       ├── secrets.ts                # NEW — 1Password keychain read + inject
│       └── preflight.ts
├── schema/
│   └── v1.json                       # NEW — JSON Schema for .apfelkaefig.json
├── templates/                        # source of truth for all three surfaces
│   ├── apfelkaefig.json              # NEW — starter config written by `akf init`
│   ├── .devcontainer/Dockerfile
│   ├── .devcontainer/devcontainer.json
│   ├── start.sh                      # written by `akf eject --bash`
│   ├── build.sh                      # written by `akf eject --bash`
│   ├── CLAUDE.block.md
│   └── gitignore.block
├── image/                            # NEW — base image source
│   ├── Dockerfile                    # the ghcr.io/apfelkaefig/base recipe
│   └── README.md
├── npm/                              # NEW — postinstall wrapper
│   ├── package.json
│   ├── postinstall.js
│   └── bin/akf.js
├── assets/chrome-bridge/             # reserved for later
├── tasks/
└── SKILL.md                          # references templates/ by path
```

`.github/workflows/image.yml` builds and pushes `ghcr.io/apfelkaefig/base` on tagged image releases
(independent versioning from the binary; binary embeds digest at build time).

---

## What changes per command

### `akf up` (NEW — canonical entry point)

Replaces the per-project `start.sh`. Resolves config (chain above), prepares mount/env flags, runs
`container run` with the built-in or configured image. Drive-by works from any directory: `akf up`
with no config = built-in image + claude default command.

- Default command: `claude --dangerously-skip-permissions`. Overridable via `command` in config and
  via positional args (`akf up bash`, `akf up -- claude --resume`).
- If image missing and `image.dockerfile` is set: auto-build (calls `akf build` internally with a
  one-line notice).
- If image missing and built-in is required: build from the embedded Dockerfile (one-time, ~5 min).
  Future: pull from registry by digest when ghcr.io publishing lands.
- Auto-injects `OP_SERVICE_ACCOUNT_TOKEN` from keychain unless disabled.
- Forwards SIGINT cleanly so Ctrl+C terminates the container.
- Preserves stdin/pty for interactive Claude.

### `akf build` (NEW)

Replaces `build.sh`. Only relevant when a custom Dockerfile is in use (config has `image.dockerfile`
or `.devcontainer/Dockerfile`).

- Spins up the local registry on `:5555` if not running, builds with Docker, pushes to local
  registry, pulls into Apple `container`, tags, tears registry down.
- Per-project image tag: `<workspace-basename>-sandbox` (preserves the fix from `a96b899`).
- `akf build --no-cleanup` keeps the registry running (useful for repeated builds during Dockerfile
  iteration).

### `akf init` (REWRITTEN)

Was: writes `.devcontainer/Dockerfile` + `devcontainer.json` + `start.sh` + `build.sh` +
`.gitignore` block + `CLAUDE.md` block.

Now: writes a starter `.apfelkaefig.json` (tier-2 setup). Idempotent. Optional flags:

- `akf init --advanced` → also writes `.devcontainer/Dockerfile` + `devcontainer.json` (tier 3).
- `akf init --bash` → equivalent to old behavior (legacy / migration aid). Same as
  `akf eject --bash` on a fresh repo.

Still writes the `.gitignore` and `CLAUDE.md` marker blocks regardless of mode.

### `akf eject --devcontainer | --bash` (NEW)

No default target — explicit selection required (errors otherwise so future targets like `--ts`,
`--deno` slot in cleanly).

- `--devcontainer`: read resolved config, write `.devcontainer/devcontainer.json` (and Dockerfile if
  custom image). Tier 2 → tier 3 promotion.
- `--bash`: write `build.sh` + `start.sh` self-contained (no akf required at runtime). Bakes
  resolved config (config file + CLI flags + defaults all merged) into the scripts.

One-way. Re-importing is documented as "use Claude to inspect and write a new `.apfelkaefig.json`" —
no migration command.

### `akf doctor` (EXTEND existing)

Current: checks `container --version`. Add:

- Apple `container` ≥ pinned floor (today's latest, e.g. `0.9.x`). Hard-fail below.
- Platform is `darwin-arm64`. Hard-fail otherwise.
- Docker present **only if** the resolved config has a custom Dockerfile (otherwise drive-by works
  without it — don't false-positive).
- `OP_SERVICE_ACCOUNT_TOKEN` in keychain **only if** `secrets.onepassword: true` is in resolved
  config. Otherwise just info-log "not configured."
- Base image presence + digest match (warns if cached digest differs from binary's expected digest —
  should never happen but cheap to check).
- Conflicting config files (`.apfelkaefig.json` AND `.devcontainer/devcontainer.json` present): warn
  that `.apfelkaefig.json` wins.

### `akf clean` (NEW)

Teardown for drive-by users ("leave no trace" promise). Stops any running sandbox for the current
workspace, removes its container, optionally removes cached images. Flags:

- (default) stop + remove container.
- `--images` also remove the project's custom image (built-in stays cached).
- `--all` also clear `~/.cache/apfelkaefig/`.

---

## `.apfelkaefig.json` schema (v1)

Format: JSONC (comments + trailing commas allowed, like `tsconfig.json` / `devcontainer.json`).
Schema published at `https://apfelkaefig.com/schema/v1.json` for IDE autocomplete.

**Curated subset, not full devcontainer mirror.** When users outgrow this they get an IDE hint
suggesting `akf eject --devcontainer`.

```jsonc
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1,

  // Image: omit for built-in, or specify one of:
  "image": "node:22-bookworm",
  // "image": { "dockerfile": ".devcontainer/Dockerfile" },

  // Mounts beyond the defaults (workspace + ~/.claude + ~/Downloads RO + ~/Desktop RO).
  "mounts": [
    { "source": "${localEnv:HOME}/.config/gh", "target": "/home/node/.config/gh" }
  ],

  // Env injected at run time. Substitution: ${localEnv:VAR}, ${localWorkspaceFolder},
  // ${localWorkspaceFolderBasename} — same dialect as devcontainer.json.
  "env": {
    "TZ": "UTC",
    "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}"
  },

  "user": "node",
  "workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}",

  "resources": { "cpus": 2, "memory": "4G" },

  "command": ["claude", "--dangerously-skip-permissions"],

  "secrets": {
    "onepassword": true // implicit when token present; false to opt out
  }
}
```

### Schema rules

- `version` is required; `1` is the only accepted value in this release.
- Unknown keys: hard error (catches typos; users who need extensibility go to tier 3).
- All paths support `${localEnv:VAR}`, `${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}`
  substitution.
- `image` shape: string (registry tag) OR `{ dockerfile: string }`. Discriminated union, no other
  shapes in v1.

---

## Critical files to modify or create

**New (Deno source under `cli/`):**

- `cli/commands/up.ts` — config resolve + container run + signal forwarding.
- `cli/commands/build.ts` — registry lifecycle + docker build + shuttle.
- `cli/commands/eject.ts` — `--devcontainer` and `--bash` modes; explicit target required.
- `cli/commands/clean.ts` — stop/remove container, optional cache cleanup.
- `cli/lib/config.ts` — `findConfig(cwd)`, `parseConfig(jsonc)`, `validate(config)`,
  `resolveConfig({ cliFlags })` — the canonical resolution chain.
- `cli/lib/schema.ts` — TS types matching `schema/v1.json`. Source of truth for the schema is
  `schema/v1.json`; types are hand-written or generated by `json-schema-to-typescript` task.
- `cli/lib/container.ts` — thin wrapper around `container run`, `container image pull`,
  `container image inspect`, `container stop`/`rm`. Centralizes flag construction.
- `cli/lib/registry.ts` — start/stop the localhost:5555 registry container.
- `cli/lib/secrets.ts` — read `OP_SERVICE_ACCOUNT_TOKEN` from macOS keychain (handle 128-char
  truncation), build env injection. Errors loudly when explicitly enabled but token missing.

**New (non-source):**

- `schema/v1.json` — JSON Schema, published to `apfelkaefig.com/schema/v1.json` (GitHub Pages).
- `templates/apfelkaefig.json` — starter config written by `akf init`. Minimal, comments pointing to
  docs.
- `image/Dockerfile` — `ghcr.io/apfelkaefig/base` recipe. Debian slim + claude + git + node + jq +
  ripgrep + curl + fd-find + tree + vim + gh.
- `image/README.md` — "this image is consumed by akf binaries via embedded digest; rebuild via
  `image.yml` workflow."
- `npm/package.json` — `bin: { akf, apfelkaefig }`, `postinstall: node ./postinstall.js`.
- `npm/postinstall.js` — fetch matching `akf-darwin-arm64` binary from GitHub release, drop in
  `node_modules/.bin/`.
- `npm/bin/akf.js` — tiny shim that execs the downloaded binary (mirrors v0.1's planned shape).
- `.github/workflows/image.yml` — build + push base image on tag `image-v*`. Outputs the
  `sha256:...` for the binary build to consume.
- `.github/workflows/release.yml` — extend: read base-image digest from `image/digest.txt`, pass to
  `deno compile` via `--env-file` so the binary embeds it.

**Rewritten:**

- `cli/commands/init.ts` — writes `.apfelkaefig.json` (default), `--advanced` adds `.devcontainer/`,
  `--bash` writes scripts (legacy mode).
- `cli/commands/doctor.ts` — extended checks per the section above.
- `cli/main.ts` — dispatch new subcommands.
- `templates/start.sh` / `templates/build.sh` — keep as eject targets but inline the resolved-config
  bake step (no longer dynamic — they're snapshots of one resolution).
- `README.md` — primary path becomes `brew install apfelkaefig && akf up`. Drive-by demo. Tiers
  explained.
- `SKILL.md` — references `templates/` by path. Outputs `.apfelkaefig.json` for tier-2 setup or
  scripts for full eject (two flow paths).

**Moved:**

- `src/` → `cli/` (everything under it).
- `src/lib/fs_test.ts` → `cli/lib/fs_test.ts`.

**Kept untouched:**

- `assets/chrome-bridge/` — still reserved.
- `LICENSE`, `POSITIONING.md`, `ARCHITECTURE_EXPLORATION.md`.
- `CLAUDE.md` — update memory-style content separately if needed.

---

## Out of scope (deferred)

- **Chrome CDP bridge / Playwright MCP wiring.** Schema reserves `chrome: { ... }` namespace but
  does not implement. Opt-in feature for v0.3.
- **Network hardening / minimum-network mode.** Task 003 territory; coordinate with this refactor
  but don't merge.
- **Multi-account 1Password** (`secrets.onepassword.account: "work"`). Schema accepts only `boolean`
  in v1; expand to discriminated union later if needed.
- **`akf list` / `akf rm` / `akf shell`.** Recover when multi-project pain hits. Shell is
  `akf up bash` for now.
- **State directory formalization.** Use `~/.cache/apfelkaefig/` ad-hoc; XDG layout can be
  refactored later.
- **Cross-platform.** arm64 macOS only. Postinstall on Linux/Windows fails with a clear message.
- **`extends:` / config inheritance.** Explicitly killed during the jam.
- **Lifecycle hooks** (postCreate, postStart). Use `command` for one-shots; not v1.
- **Image upgrade UX.** Re-pulled only when binary upgrades. No `akf upgrade` command.
- **Telemetry.** None.

---

## Verification

**Dev loop (from source):**

1. `deno task test` — unit tests for `lib/config.ts` (resolution chain edge cases), `lib/secrets.ts`
   (keychain read mock + truncation handling), `lib/container.ts` (flag construction).
2. `deno task dev up` in a tmp scratch dir — drive-by smoke test. Asserts container starts, exits
   cleanly on Ctrl+C.
3. `deno task dev init` in a tmp scratch dir — asserts `.apfelkaefig.json` written, schema reference
   set, valid JSONC.

**Compiled dogfood (against this repo):**

1. `deno task compile` produces `dist/akf` with the embedded base Dockerfile bundled (via
   `--include ./image`).
2. `./dist/akf doctor` — all checks pass; docker reports as required because the built-in base is
   built locally; base image reports "not cached (will build on first use)" or "cached" depending on
   prior runs.
3. `./dist/akf up` from this repo's root — first run prints "building (one-time, ~5 min)…" and
   produces `apfelkaefig-base:<hash>`; subsequent runs skip the build. Container starts, claude
   available, `pwd` shows `/workspaces/apfelkaefig`. Quit.
4. `./dist/akf eject --devcontainer` — produces `.devcontainer/devcontainer.json` valid against the
   devcontainer spec; equivalent to current state. Re-running is idempotent.
5. `./dist/akf eject --bash` — produces `build.sh` + `start.sh` that boot the same container without
   akf installed. Verify by renaming `dist/akf` aside and running the scripts.
6. `./dist/akf clean` — container removed, no orphan processes.
7. **Drive-by smoke** — in a fresh `/tmp/blank` directory with no config, `akf up bash` boots the
   built-in image, drops into a shell. `~/.claude` mounted RW. No files written to `/tmp/blank`.
8. **1Password roundtrip** — with `OP_SERVICE_ACCOUNT_TOKEN` in keychain, `akf up` and inside the
   container run `op whoami` — succeeds. Set `secrets.onepassword: false` in config, re-run,
   `op whoami` fails (token not injected).
9. **Conflicting-config warning** — repo with both `.apfelkaefig.json` and
   `.devcontainer/devcontainer.json`: `akf doctor` warns; `akf up` honors the apfelkaefig file.
10. **Schema validation** — write an `.apfelkaefig.json` with an unknown top-level key. `akf up`
    fails with a schema error pointing at the offending key.
11. **Embedded Dockerfile cache** — delete `~/.cache/apfelkaefig/base/`, run `akf up`. The cache dir
    is recreated, the Dockerfile materialized, and the build runs again. Re-running `akf up` after
    that is fast (no rebuild).

**Migration path verification:**

- v0.1 project (with `build.sh`/`start.sh` from old `akf init`) — old scripts still boot a
  container. Running new `akf up` works alongside. Running `akf eject --bash` overwrites the scripts
  with the new resolved-config snapshot.
