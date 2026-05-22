# Plan: 006 - Curated plugin architecture

## Context

`akf init` is currently template-driven: it writes `.apfelkaefig.json`, optional `.devcontainer/`
artifacts, optional bash eject artifacts, and marker-managed project notes. Runtime behavior is then
driven by the strict v1 JSONC config and the compiled `akf` binary.

That is a good fit for a plugin system, but only if "plugin" means a curated capability shipped with
`akf`, not arbitrary third-party code loaded from a project. Plugins should make common sandbox
capabilities easy to add to both fresh projects and long-lived workspaces without turning `akf` into
a remote plugin runtime, package manager, or Docker Compose replacement.

Target UX:

```bash
akf init --plugins 1password
akf plugin add crit
akf plugin add 1password
```

The first implementation should document the architecture, then implement the plugin system with the
already-natural capabilities (`1password`, then other repo-owned integrations). Crit
(<https://crit.md/>) comes after the mechanism is proven.

Out of scope for v1: repo-local plugin execution, remote marketplaces, plugin signing, automatic
"latest" resolution, arbitrary lifecycle hooks, and multi-service orchestration. If a project needs
multiple cooperating services (`compose.yaml`, database + app + worker, etc.), `akf` should detect
that boundary and offer devcontainer/compose guidance or eject paths rather than half-supporting it.

---

## Architecture

### Concepts

Keep three concepts separate:

- **Init detection / resolver input:** inspect a folder and infer good defaults. Example: a Next.js
  project usually wants Node tooling, package-manager detection, a dev command, and port 3000.
- **Plugins:** built-in capabilities with config. Examples: `1password`, `crit`, browser bridge,
  package-cache volumes, port publishing, network recording.
- **Presets:** named compositions of plugins and plugin settings. Examples: `hackathon-judge`,
  `web-app`, `minimal`. Presets are not a separate security mode; they are resolver input.

The central abstraction is a **resolver**:

```text
project detection + presets + plugins + user overrides -> concrete runtime config + rendered files
```

The resolver must be explainable. A future `akf explain` or `akf init --dry-run` should show what
was detected, which plugins/settings were selected, and why.

### Plugin model

Plugins are built-in manifests in the compiled binary. Each manifest is pure data plus curated
TypeScript merge/render/check logic owned by this repo.

Internal manifest shape:

```ts
interface BuiltInPlugin<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  aliases: string[];
  description: string;
  defaultConfig: TConfig;
  mergeConfig?: (existing: TConfig | undefined, requested: Partial<TConfig>) => TConfig;
  applyConfig?: (base: ApfelkaefigConfig, config: TConfig) => ApfelkaefigConfig;
  dockerfileBlocks?: (config: TConfig) => MarkerBlock[];
  markerBlocks?: (config: TConfig) => MarkerBlock[];
  files?: (config: TConfig) => Array<{ path: string; contents: string; mode?: number }>;
  doctorChecks?: (config: TConfig) => DoctorCheck[];
  postApplyMessages?: (config: TConfig) => string[];
}
```

Rules:

- Plugin ids are canonicalized before writing config (`1password` and `op` become `1password`).
- Unknown ids fail fast with the supported plugin list.
- Plugin config is explicit per plugin, not a string array.
- Plugins never execute project-provided code during `init`, `plugin add`, `up`, `doctor`, or
  `eject`.
- Plugin changes are deterministic and idempotent.
- Ambiguous or destructive mutations ask; unambiguous additions apply directly.
- Generated changes to user-visible files are written as owned marker blocks.

### Public CLI

Add plugin subcommands:

```bash
akf plugin list
akf plugin explain crit
akf plugin add crit
akf plugin add 1password
akf plugin remove crit
```

`remove` can be later than `add`, but the block ownership model should make it straightforward.

`akf init --plugins ...` remains useful for fresh projects:

```bash
akf init --plugins 1password,crit
akf init --advanced --plugins 1password
akf init --bash --plugins 1password
```

Parsing:

- Comma-separated list for `init --plugins`.
- Trim whitespace.
- Empty entries are rejected.
- Existing `--advanced` and `--bash` modes continue to work.

### Config shape

Add top-level plugin config:

```jsonc
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1,
  "plugins": {
    "1password": {
      "enabled": true
    },
    "crit": {
      "enabled": true,
      "agentIntegration": "codex"
    }
  }
}
```

This replaces the earlier array idea (`"plugins": ["crit", "1pw"]`). Per-plugin config is the
building block for presets because presets can compose plugins with settings instead of merely
listing plugin ids.

Plugin config is **intent**. Rendered Dockerfile blocks, `.gitignore` blocks, project notes, ports,
mounts, volumes, and env vars are outputs derived from that intent. `akf doctor` should detect drift
between plugin config and rendered outputs.

### Presets

Presets compose plugins and plugin settings:

```jsonc
{
  "preset": "hackathon-judge",
  "plugins": {
    "node": { "enabled": true },
    "network-record": { "enabled": true },
    "browser-preview": { "enabled": true }
  }
}
```

Presets should not hide behavior. Either store resolved settings explicitly or make `akf explain`
show the full expansion.

The `hackathon-judge` preset is future-facing, but it should shape the design now:

- Workspace is isolated by copy or disposable volume, not a direct host bind by default.
- Host home, Downloads, Desktop, and agent config are not mounted by default.
- Secrets are disabled by default.
- Agent profile is stripped down: no ambient host MCPs and no durable auth.
- Network is open by default.
- Network recording is enabled by default.
- Cleanup can wipe the working volume while preserving exported logs/artifacts.

Network policy should be a first-class intent axis even if v1 only implements open/default behavior:

```text
open -> record -> allowlist -> prompt
```

`record` should likely come before a LuLu-style `prompt` mode. Prompt mode is harder because it may
need DNS/proxy support, generally approves domains/IPs rather than full URLs, and can become noisy
during package installs.

### Owned artifacts

`.apfelkaefig.json` is the canonical structured config and can be edited structurally.

Any mutation to an existing or user-visible file must use owned marker blocks, including:

- `.devcontainer/Dockerfile`
- `.gitignore`
- `CLAUDE.md`
- agent/project guidance files where `akf` is modifying rather than owning the whole file

Example:

```dockerfile
# >>> akf plugin: crit
RUN ...
# <<< akf plugin: crit
```

Whole generated files are acceptable only when clearly owned by `akf` and not expected to be edited
by users. Prefer marker blocks for Dockerfiles and docs.

### Image composition

If any selected plugin requires packages or binaries not present in the built-in base image, the
resolver writes or updates a generated `.devcontainer/Dockerfile` block and sets:

```jsonc
"image": { "dockerfile": ".devcontainer/Dockerfile" }
```

Do not hide plugin image changes inside build-time magic. If a project depends on a tool being
present in the sandbox, the Dockerfile should make that dependency inspectable.

### Project detection

Future init detection should infer defaults without treating repo contents as trusted instructions.
For example:

- Next.js/Vite/SvelteKit: dev port, package manager, dev command.
- Python/Django/FastAPI: Python tooling, uv/pip cache, app port.
- Rails/Phoenix: runtime/tooling hints and likely ports.

LLM-assisted analysis may propose config, but must treat repo contents as hostile data. It must not
execute commands, follow README instructions, fetch arbitrary URLs, or auto-enable secrets based on
project text.

---

## Built-in plugins

### `1password`

Aliases: `1pw`, `op`.

Config:

```jsonc
"plugins": {
  "1password": {
    "enabled": true
  }
}
```

Behavior:

- Set or preserve `"secrets": { "onepassword": true }`.
- Add a short marker-managed `CLAUDE.md` block explaining that secrets should be resolved inside the
  sandbox with `op read`.
- Do not add a Dockerfile fragment initially because the current base image already ships `op`.
- `doctor` should fail when the project explicitly enables `1password` but no service account token
  is available from env or macOS keychain.

### `crit`

Aliases: `crit`.

Crit is <https://crit.md/>.

Config:

```jsonc
"plugins": {
  "crit": {
    "enabled": true,
    "agentIntegration": "codex",
    "installMethod": "binary"
  }
}
```

Behavior:

- Install or expose a pinned Crit CLI version inside the sandbox.
- Configure any required port/proxy behavior only after confirming Apple `container` publishing.
- Integrate Crit's agent files carefully. Crit may create its own files (for example via
  `crit install codex`); do not pretend those files are `akf`-owned unless `akf` renders them.
- Add marker-managed project guidance describing how an agent should run Crit and read its review
  output.
- Add `doctor` checks for Crit binary availability, agent integration files, and port/proxy
  usability when configured.

Open spike: Crit's local browser UI depends on host/container port exposure. Before finalizing
forwarding, confirm the current Apple `container` publish syntax and behavior. If reliable port
publishing is not available, the Crit plugin must not pretend the in-container UI is reachable from
the host; instead, emit a post-apply message with the host-side Crit command.

---

## Implementation plan

### 1. Document architecture

This task is the first step. Keep architecture decisions here before changing the code.

### 2. Core plugin registry

Add `cli/lib/plugins.ts`:

- Built-in registry for `1password` first, then `crit`.
- `resolvePluginId(id: string): string`.
- `resolvePluginRequest(idsOrConfigs): ResolvedPlugin[]`.
- `mergePluginConfig(base, requested)` with deterministic conflict behavior.
- Helpers for marker block rendering, generated Dockerfile composition, and collision/drift
  detection.

### 3. Schema and config

Update:

- `schema/v1.json`
- `cli/lib/schema.ts`
- `cli/lib/config.ts`

Required behavior:

- Accept plugin config object.
- Reject unknown plugin ids.
- Reject malformed plugin settings.
- Preserve strict unknown-key validation outside plugin-defined config.
- Keep plugin config as intent and derive runtime fields through the resolver.

### 4. `akf plugin add`

Update `cli/main.ts` and add a plugin command module if useful:

- Read existing config or initialize minimal `.apfelkaefig.json`.
- Resolve and canonicalize plugin id.
- Merge plugin config.
- Render owned blocks/files.
- Apply immediately when deterministic and non-destructive.
- Ask only on ambiguity, drift, collision, or overwrite risk.
- Support `--dry-run` eventually.

### 5. `akf init`

Update `cli/main.ts` and `cli/commands/init.ts`:

- Parse `--plugins` as a string flag.
- Resolve/canonicalize plugin ids before writing anything.
- Write `.apfelkaefig.json` with canonical plugin config.
- Generate or update `.devcontainer/Dockerfile` marker blocks when plugin image fragments are
  present.
- Write plugin files and marker blocks idempotently.
- Print post-apply messages after the existing "Next steps" output.

### 6. Runtime, doctor, and eject

Update runtime support:

- `cli/lib/container.ts`: render plugin-derived ports, mounts, volumes, env, and user settings after
  resolver support lands.
- `cli/commands/eject.ts`: preserve plugin config and rendered runtime effects in both
  `--devcontainer` and `--bash` output.
- `cli/commands/doctor.ts`: report configured plugins, run plugin-specific checks, and detect drift
  between plugin config and owned artifacts.

### 7. Presets

Implement presets only after plugins are solid. Presets should mostly be resolver input, not custom
runtime behavior.

---

## Automated tests

### Unit tests

Config/schema:

- Accept plugin config object.
- Reject old malformed plugin array if the final schema no longer supports it.
- Canonicalize aliases during `init`/`plugin add` output.
- Reject unknown plugin ids.
- Reject duplicate canonical ids in `akf init --plugins`.
- Reject malformed plugin settings.
- Preserve strict unknown-key validation.

Plugin resolver:

- Merge a plugin into an empty config.
- Merge a plugin into an existing config without dropping unrelated settings.
- Re-running the same plugin add is idempotent.
- Conflicting settings produce deterministic errors or prompts.
- Plugin config remains intent; derived runtime config is computed separately.

Owned artifacts:

- Insert marker blocks.
- Update marker blocks.
- Detect drift inside marker blocks.
- Refuse unsafe collisions before partial writes.
- Remove marker blocks when `plugin remove` is implemented.

Runtime rendering:

- `buildRunArgs` includes plugin-derived port flags when configured.
- `buildRunArgs` includes plugin-derived env/mounts/volumes.
- Future judging/minimal presets can assert no host home/Desktop/Downloads mounts.
- `eject --devcontainer` preserves plugin-induced image, env, secrets, mounts, and ports.
- `eject --bash` renders equivalent run flags and generated image handling.
- `doctor` reports plugin-specific checks only for enabled plugins.

### CLI integration tests without VM

These should run by default in temp directories and not require Apple `container`:

- Fresh repo: `akf init --plugins 1password`.
- Existing akf repo: `akf plugin add 1password`.
- Re-run `akf plugin add 1password`.
- Existing config with unrelated mounts/env is preserved.
- Generated `.apfelkaefig.json` contains canonical plugin config.
- Marker blocks appear in expected files.
- `akf eject --devcontainer` and `akf eject --bash` preserve plugin intent/effects.

### Command rendering tests with fake runner

Use the existing `Runner` seam to assert Apple `container` commands without launching a VM:

- Named volumes are created with `container volume create`.
- `container run` receives expected `-v`, `-e`, `-u`, `-w`, image, and command args.
- Port publish flags are rendered once syntax is confirmed.
- No duplicate mount targets are emitted.
- Read-only mounts render with `:ro`.

### Environment-gated integration tests

Add opt-in test tasks later:

```jsonc
{
  "tasks": {
    "test:integration": "AKF_INTEGRATION=1 deno test --allow-all tests/integration",
    "test:external": "AKF_EXTERNAL=1 deno test --allow-all tests/external"
  }
}
```

`AKF_INTEGRATION=1` tests require Apple `container` and Docker:

- Build image.
- `akf up -- echo ok`.
- Named volume create/mount smoke.
- Read-write volume writes persist.
- Read-only bind mount refuses writes.
- Runtime user is non-root.
- Root-owned/protected paths cannot be mutated by runtime user.
- Exposed port is reachable from host once Apple `container` supports it reliably.
- Cleanup removes container and expected volumes.

`AKF_EXTERNAL=1` tests require internet and real credentials:

- 1Password token is available.
- `op read` succeeds inside the sandbox.
- No raw secret appears in generated config.
- Crit CLI install/version check.
- Crit smoke command against a tiny fixture repo.

### Malicious fixture tests

Use deterministic fixtures where possible:

- Package `postinstall` tries to write outside workspace.
- Script tries to read `/home/node/.claude` when the preset should not mount it.
- Script tries to write to a read-only mount.
- Script tries outbound network under a deny policy once implemented.
- Script tries to persist data in a cache volume.
- Fixture app opens a port for port-forward smoke.

---

## Manual verification

Manual testing should be small. Most checks above should become automated or environment-gated. Keep
2-3 high-confidence manual scenarios:

### 1. Existing daily workspace extension

```bash
akf plugin add 1password
akf doctor
akf up -- bash
```

Expected:

- Existing `.apfelkaefig.json` settings are preserved.
- `plugins.1password.enabled` is present.
- Owned project guidance block is inserted once.
- Re-running `akf plugin add 1password` is a no-op.
- Inside the sandbox, `op read ...` works when the service account token is available.
- No raw secret is written to config or generated files.

### 2. Dockerfile / marker block drift

```bash
akf plugin add crit
# manually edit inside the generated crit marker block
akf plugin add crit
akf doctor
```

Expected:

- `akf` detects drift or ambiguity instead of silently overwriting user edits.
- `doctor` explains which owned artifact is out of sync.
- No unrelated Dockerfile or config content is changed.

### 3. Hackathon judging smoke once preset exists

```bash
akf init --preset hackathon-judge
akf up -- npm install
akf up -- npm test
akf network report
akf clean
```

Expected:

- Network is open enough for dependency install.
- Network recording captures useful outbound destinations.
- Host home, Downloads, Desktop, and durable agent credentials are not mounted.
- Logs/artifacts can be exported before cleanup.
- Cleanup wipes the project working volume without touching host files.
