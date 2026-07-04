# Plan: 011 — Plugin runtime hooks (minimal core, powerful plugins)

## Status

**All seven implementation steps are done.** Deviations from the letter of the plan, chosen while
implementing:

- Marker blocks did NOT gain a version in the start marker (decision 10) — changing the marker
  text would orphan existing blocks, and content comparison alone already answers "does this need
  a re-render". The ownership contract is stated in a comment line inside each block instead.
- The serve-beats-tmux rule stayed as one line of core sugar (`tmuxEnabled … && !opts.serve`)
  rather than plugin-declared exclusivity (decision 7) — expressing it in the ssh plugin would
  couple the two plugins for no consumer benefit. Command *replacement* suppressing `wrapCommand`
  hooks is generic, via `PreRunResult.overrides`.
- JSONC configs are never rewritten by the auto-migration (a JSON round-trip would destroy
  comments); they get an advisory note listing the removable entries instead.

## Context

A full review of the plugin system (2026-07) surfaced one structural flaw and its consequences:

- **Materialize-at-add.** `applyConfig` runs once, at `akf plugin add`, and writes derived state
  (mounts, ports, `image`) into `.apfelkaefig.json`. Nothing at runtime re-applies plugin
  transforms. Editing `plugins.telegram.sha` or `plugins.ssh.port` afterwards changes nothing — the
  Dockerfile block keeps the old SHA baked as a literal `ARG`, `ports[]` keeps publishing the old
  port. The drift refusal in `upsertBlock` (`cli/lib/fs.ts:145`) then _blocks_ the repair path:
  re-running `akf plugin add` renders the block from the new config, which no longer matches the old
  block, and throws "owned block differs from generated content". There is no supported way to bump
  the telegram pin today, even though the doctor and the generated Dockerfile both tell the user to
  do exactly that.
- **Run logic leaking into core.** The ssh plugin owns image + config, but ~50 lines of its run
  behavior (`SSH_ENTRYPOINT`, key reading, root/tty overrides, `akf-serve-*` naming, the banner)
  live inline in `cli/commands/up.ts:237-279`. tmux is fully hardcoded across `up.ts` /
  `container.ts`. Each new runtime-flavored feature would grow another branch in core.

Direction decided: **make plugins more powerful, keep the core minimal.** Extend the plugin
interface with run-lifecycle hooks and move functionality out of `up.ts` into plugins — including
features (tmux, 1Password) that predate the plugin system.

## Decisions

Numbered as discussed; these are settled, not open questions.

1. **Hook surface: exactly what existing consumers need, nothing speculative.** The three consumers
   are ssh `--serve`, tmux, and 1Password. That yields five hooks (sketch below): `transformConfig`,
   `preRun`, `runtimeEnv`, `wrapCommand`, `containerName`. No post-run hooks, no watchers, no event
   bus — add a hook only when a concrete plugin needs it. (Guideline recorded in CLAUDE.md.)

2. **Materialize vs. resolve: split per _effect_, not per plugin.**
   - _Materialized (files on disk):_ Dockerfile blocks (build inputs) and CLAUDE.md blocks (read by
     the agent, not by akf). These must exist as files; they stay written by `init`/`add`/`sync`.
   - _Resolved at runtime (`container run` arguments):_ mounts, ports, env, image ref. Computed on
     every `akf up` from `plugins.{id}` config via `transformConfig`; **never** written into
     `.apfelkaefig.json`. This kills the two-sources-of-truth bugs while keeping builds
     reproducible.

3. **Generated blocks are machine-owned: overwrite without asking.** Drop the drift refusal.
   `upsertBlock` re-renders owned blocks idempotently every time (`overwrite: true`), printing
   "updated" when content changed. A user who wants to hand-maintain a block removes the
   `# >>> akf plugin: … <<<` markers — no markers, akf appends a fresh block but never touches the
   de-adopted copy. Document this contract in the markers themselves ("machine-owned; edits will be
   overwritten — remove these markers to take ownership").

4. **tmux becomes an _internal_ plugin; its user surface doesn't change.** The tmux logic
   (`wrapCommand` for the session wrap, `containerName` for the stable name, `preRun` for the
   attach-vs-run branch) moves into `cli/plugins/tmux/plugin.ts` using the same hooks as every other
   plugin — one mechanism in the codebase. Users never write `plugins.tmux`: the existing top-level
   `tmux: true` key and the `--tmux` flag are sugar that enables the internal plugin. This keeps
   drive-by (tier 1) and devcontainer (tier 3) projects working with no config file. While moving
   it, fix the container-name collision: `sandboxContainerName` gains a path-hash suffix
   (`akf-<slug>-<djb2Hex(workspaceDir).slice(0,8)>`, same scheme as the telegram plugin's instance
   volumes) so two projects with the same basename can't attach to each other's sandbox or `rm -f`
   each other's stopped box. Same fix for `akf-serve-*`.

5. **1Password becomes a real plugin, backwards compatible.** The `resolveOp` injection moves from
   `up.ts:217-227` into the 1password plugin's `runtimeEnv` hook. `secrets.onepassword` stays
   accepted as a deprecated alias: the config validator maps it onto `plugins.1password` and emits a
   one-line deprecation warning. Remove the alias in a future major version, not now.

6. **Plugins own CLI flags; collisions are developer errors.** A plugin declares `flags: ["serve"]`;
   the `up` parser accepts declared flags generically and hands them to the plugin's `preRun` ctx.
   Because plugins are compiled-in (decision 8), a collision — two plugins claiming `--foo`, or a
   plugin claiming a core flag like `--rebuild` — is caught at **registry construction** (throw on
   duplicate) and pinned by a unit test that asserts global flag uniqueness. No runtime precedence
   rules.

7. **Deterministic hook order = order in the config file.** `wrapCommand` composes (later plugins
   wrap the already-wrapped command). Exclusive hooks — `containerName`, full command _replacement_
   — error loudly if two enabled plugins claim them. The one known interaction, `--serve` disabling
   tmux wrapping, becomes an explicit rule in the ssh plugin (its command replacement declares
   exclusivity) instead of the silent `&& !opts.serve` in `up.ts:89`.

8. **Built-in only, compiled in.** No dynamic loading, no third-party plugins. Arbitrary code with
   `preRun` powers in a tool whose pitch is sandboxing is a trust problem, and dynamic import fights
   `deno compile`. Revisit only on concrete external demand. (Guideline in CLAUDE.md.)

9. **Generate `schema/v1.json` from plugin-owned fragments.** Each plugin exports its JSON-schema
   fragment and TS config type next to its implementation; a `deno task gen-schema` assembles
   `schema/v1.json` (checked in, CI-diffable). Kill the central `PluginConfigMap` in
   `cli/lib/schema.ts` in favor of registry-derived typing. Adding a plugin then touches one
   directory instead of 4–5 files.

10. **Migration + versioning: `akf up` self-heals old configs.** Existing projects (including this
    repo's own `.apfelkaefig.json`) carry materialized leftovers — ssh's mounts/ports written at
    add-time, now also derived at runtime. Plan:
    - Runtime resolution dedupes by mount target and by host port, so leftovers are harmless on day
      one.
    - `akf up` detects materialized state that runtime resolution now derives (exact match of a
      derived mount/port against a config entry) and **auto-updates** the config: strips the
      leftovers, writes the result, prints one line
      (`updated .apfelkaefig.json: removed 3 entries now derived by plugins (backup: .apfelkaefig.json.bak)`).
    - Marker blocks gain a version in the start marker (`# >>> akf plugin: ssh v2`); `akf up` (cheap
      check) or `akf plugin sync` re-renders when the version or rendered content differs — this is
      the "changed behaviours auto-update" routine.
    - Config `version` stays `1` (all changes here are additive). The auto-migration machinery is
      the foundation: when a breaking schema change eventually lands, `version: 2` reuses the same
      detect-migrate-backup-report path.

## Interface sketch

```ts
// cli/plugins/types.ts — additions. All hooks optional; a config-only plugin
// (1password before this plan) is still valid.
export interface RunContext {
  resolved: ResolvedConfig; // config with transformConfig already applied
  workspaceDir: string;
  flags: Record<string, boolean>; // this plugin's declared flags, parsed from `akf up`
  run: Runner; // for `container …` subcommands (preRun orphan cleanup etc.)
}

export interface BuiltInPlugin {
  // …existing fields (id, aliases, description, validateConfig, defaultConfig,
  // markerBlocks, dockerfileBlocks, doctorChecks, setupSteps, postApplyMessages)…

  // Replaces applyConfig. Runs at resolveConfig time on EVERY invocation; the
  // result is used for `container run` args and never written to disk.
  transformConfig?: (
    base: ApfelkaefigConfig,
    config: Record<string, unknown>,
    ctx: PluginContext,
  ) => ApfelkaefigConfig;

  // CLI flags this plugin owns on `akf up`. Uniqueness enforced at registry init.
  flags?: string[];

  // Validation, banners, attach-vs-run branches, orphan cleanup. Returning an
  // exit signal stops `akf up`; "attach" hands over to an alternate spawn path.
  preRun?: (ctx: RunContext) => Promise<
    { action: "continue" } | { action: "exit"; code: number } | { action: "attach"; args: string[] }
  >;

  // Env injected at run time (OP token, authorized key). Never persisted.
  runtimeEnv?: (ctx: RunContext) => Promise<Record<string, string>>;

  // Compose-wrap the in-container command (tmux). Applied in config order.
  wrapCommand?: (command: string[], ctx: RunContext) => string[];

  // Exclusive: stable container name. Two claimants → hard error.
  containerName?: (ctx: RunContext) => string;
}
```

## Implementation order

Each step lands green on its own; later steps depend on earlier ones.

1. **Runtime resolution** (decision 2): add `transformConfig`, apply enabled plugins in
   `resolveConfig`, port ssh/crit/telegram/1password's `applyConfig` bodies over, dedupe
   mounts/ports at build-args time. `akf plugin add` stops writing derived state.
2. **Machine-owned blocks + `akf plugin sync`** (3): flip `upsertBlock` to overwrite for
   plugin-owned markers, add versioned markers, wire sync into `init`/`add`.
3. **Migration routine** (10): leftover detection + auto-strip with backup in `akf up`.
4. **1Password plugin** (5): `runtimeEnv` hook, `secrets.onepassword` alias + deprecation warning.
5. **ssh `--serve` moves into the plugin** (6, 7): flag declaration, `preRun` (validation, orphan
   cleanup, banner), `runtimeEnv` (authorized key), command replacement with exclusivity.
6. **tmux internal plugin** (4): `wrapCommand`/`containerName`/`preRun` attach path; top-level
   `tmux` key + `--tmux` flag as enabling sugar; container-name hash suffix fix.
7. **Schema generation** (9): per-plugin fragments, `deno task gen-schema`, drop `PluginConfigMap`.

## Out of scope

- Third-party / dynamically loaded plugins (decision 8).
- Post-run hooks, watchers, background daemons — no consumer exists (decision 1).
- `version: 2` config schema — this plan builds the migration machinery, not a breaking change.
- `akf plugin remove` — worth doing once blocks are machine-owned (it becomes "delete config
  section + strip blocks"), but it's a follow-up, not a dependency.
