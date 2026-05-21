# Plan: 006 — Curated plugin architecture

## Context

`akf init` is currently template-driven: it writes `.apfelkaefig.json`, optional `.devcontainer/`
artifacts, optional bash eject artifacts, and marker-managed project notes. Runtime behavior is
then driven by the strict v1 JSONC config and the compiled `akf` binary.

That is a good fit for a small plugin system, but only if "plugin" means a curated recipe shipped
with `akf`, not arbitrary third-party code loaded from a project. The immediate trigger is
[`crit.md`](https://crit.md/): Crit looks useful for agent review workflows, and it naturally maps
to project setup, an installed CLI, agent-facing instructions, and possibly a local browser UI.

Target UX:

```bash
akf init --plugins crit,1pw
```

The goal is to let users opt into known integrations without turning `akf` into a remote plugin
runtime or a package manager.

Out of scope for v1: repo-local plugin execution, remote marketplaces, plugin signing, automatic
"latest" resolution, and arbitrary lifecycle hooks.

---

## Architecture

### Plugin model

Plugins are built-in manifests in the compiled binary. Each manifest is pure data plus curated
TypeScript merge/render logic owned by this repo.

Internal manifest shape:

```ts
interface BuiltInPlugin {
  id: string;
  aliases: string[];
  description: string;
  configPatch?: Partial<ApfelkaefigConfig>;
  dockerfileFragments?: string[];
  files?: Array<{ path: string; contents: string; mode?: number }>;
  markerBlocks?: Array<{ path: string; markers: Markers; contents: string }>;
  doctorChecks?: string[];
  postInitMessages?: string[];
}
```

Rules:

- Plugin ids are canonicalized before writing config (`1password` and `op` become `1pw`).
- Unknown ids fail fast with the supported plugin list.
- Duplicate canonical ids are rejected.
- Plugin file collisions are detected before any plugin files are written.
- Plugins never execute project-provided code during `init`, `up`, `doctor`, or `eject`.

### Public CLI

Add a string flag to `akf init`:

```bash
akf init --plugins crit,1pw
akf init --advanced --plugins crit,1password
akf init --bash --plugins 1pw
```

Parsing:

- Comma-separated list.
- Trim whitespace.
- Empty entries are rejected.
- Existing `--advanced` and `--bash` modes continue to work.

### Config shape

Add top-level plugin metadata:

```jsonc
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1,
  "plugins": ["crit", "1pw"]
}
```

Add ports only when required by a selected plugin:

```jsonc
"ports": [
  { "host": 7474, "container": 7474 }
]
```

`plugins` is declarative metadata and a way for `doctor`, `eject`, and future upgrades to understand
why generated artifacts exist. It is not a runtime extension-loading mechanism.

### Image composition

If any selected plugin requires packages or binaries not present in the built-in base image,
`akf init` writes a generated `.devcontainer/Dockerfile` and sets:

```jsonc
"image": { "dockerfile": ".devcontainer/Dockerfile" }
```

The generated Dockerfile starts from the embedded base Dockerfile content and appends clearly marked
plugin sections. This keeps plugin-driven image changes visible in the repo and compatible with the
existing `akf build`, `akf up`, `akf eject --devcontainer`, and `akf eject --bash` paths.

Do not hide plugin image changes inside build-time magic. If a project depends on Crit being present
in the sandbox, the Dockerfile should make that dependency inspectable.

---

## Built-in plugins

### `1pw`

Aliases: `1password`, `op`.

Behavior:

- Set `"secrets": { "onepassword": true }`.
- Add a short marker-managed `CLAUDE.md` block explaining that secrets should be resolved inside
  the sandbox with `op read`.
- Do not add a Dockerfile fragment initially because the current base image already ships `op`.
- `doctor` should fail when the project explicitly enables `1pw` but no service account token is
  available from env or macOS keychain.

### `crit`

Aliases: `crit`.

Behavior:

- Add a Dockerfile fragment that installs a pinned Crit CLI version.
- Add agent-facing Crit files for repo-local use. Prefer `.agents/skills/crit/...` for Codex-targeted
  instructions unless Crit's upstream install guidance requires a different layout.
- Add marker-managed project guidance describing how an agent should run Crit and read its review
  output.
- Add `doctor` checks for Crit availability in the configured image path.

Open spike: Crit's local browser UI depends on host/container port exposure. Before finalizing
forwarding, confirm the current Apple `container` publish syntax and behavior. If reliable port
publishing is not available, the Crit plugin must not pretend the in-container UI is reachable from
the host; instead, emit a post-init message with the host-side Crit command.

---

## Implementation plan

### Core plugin registry

Add `cli/lib/plugins.ts`:

- Built-in registry for `crit` and `1pw`.
- `resolvePlugins(ids: string[]): BuiltInPlugin[]`.
- `mergePluginConfig(base, plugins)` with deterministic conflict behavior.
- Helpers for generated Dockerfile composition and collision detection.

### `akf init`

Update `cli/main.ts` and `cli/commands/init.ts`:

- Parse `--plugins` as a string flag.
- Resolve/canonicalize plugin ids before writing anything.
- Write `.apfelkaefig.json` with canonical `"plugins"` and merged config.
- Generate `.devcontainer/Dockerfile` when plugin image fragments are present.
- Write plugin files and marker blocks idempotently.
- Print post-init messages after the existing "Next steps" output.

### Runtime and eject

Update config/schema/runtime support:

- `schema/v1.json` and `cli/lib/schema.ts`: add `plugins` and `ports`.
- `cli/lib/config.ts`: validate plugin ids and port entries.
- `cli/lib/container.ts`: render port publish flags from resolved config after the Apple
  `container` syntax spike.
- `cli/commands/eject.ts`: preserve `plugins`, plugin-induced image changes, and ports in both
  `--devcontainer` and `--bash` output.
- `cli/commands/doctor.ts`: report configured plugins and run their built-in checks.

---

## Tests

### Config tests

- Accept `"plugins": ["crit", "1pw"]`.
- Canonicalize aliases during init output, not during raw config parse.
- Reject unknown plugin ids.
- Reject duplicate canonical ids in `akf init --plugins`.
- Reject malformed `plugins` and malformed `ports`.
- Preserve strict unknown-key validation.

### Init tests

- `akf init --plugins crit,1pw` writes canonical plugin ids.
- `akf init --plugins 1password,crit` writes `["1pw", "crit"]`.
- Plugin image fragments produce `.devcontainer/Dockerfile` and set `image.dockerfile`.
- Re-running init is idempotent.
- Plugin file collisions fail before partial writes.

### Runtime/render tests

- `buildRunArgs` includes port flags when configured.
- `eject --devcontainer` preserves plugin-induced image, env, secrets, mounts, and ports.
- `eject --bash` renders equivalent run flags and generated image handling.
- `doctor` reports plugin-specific checks only for projects declaring those plugins.

## Verification

Manual smoke in a throwaway repo:

```bash
akf init --plugins crit,1pw
akf doctor
akf up -- bash
```

Expected:

- `.apfelkaefig.json` contains canonical plugin ids.
- `.devcontainer/Dockerfile` exists when Crit requires an image addition.
- `doctor` explains any missing 1Password token or Crit/port prerequisite.
- `akf up` launches with the generated image and no hidden plugin execution.
- `akf eject --devcontainer --force` and `akf eject --bash --force` preserve the same behavior.

