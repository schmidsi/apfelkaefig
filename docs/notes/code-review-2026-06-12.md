# Code review — full repo, 2026-06-12

Scope: every file in the repo (CLI source, tests, templates, schema, npm packaging, docs).
Baseline: commit 7b49286, 133/133 tests passing, `deno check` and `deno lint` clean.

## Verdict

The codebase is in good shape for its stated goal ("works on Simon's machine, ships fast").
The architecture is coherent: thin command layer over testable libs, a `Runner` seam for
subprocess mocking, marker-managed idempotent file edits, and a three-tier config model that
is consistently enforced. Comments explain *why* (EBUSY dedupe, 128-char keychain truncation,
pnpm hoisting) — the best property of this repo. The findings below are mostly consistency
and dead-weight issues, plus a handful of real UX bugs in argument parsing and error handling.

---

## 1. Bugs / UX issues

### 1.1 `akf up --help` launches the sandbox (main.ts:39-41, 91-107)

`up` is special-cased before the global flag parse, and `dispatchUp`'s `parseArgs` does not
declare `help`. Unknown flags land in the flags object, not in `_`, so `--help` is silently
swallowed and the sandbox boots. Same class of bug: `akf up claude --resume` (without `--`)
silently drops `--resume` — parseArgs eats any unknown flag before the `--`. The docs always
show the `--` form, but the failure mode is silent. Fix: handle `help` in `dispatchUp`, and/or
pass an `unknown` callback that either errors or forwards unrecognized flags into the command.

### 1.2 Edited plugin marker block → raw stack trace (fs.ts:99, main.ts:157)

`upsertBlock` throws a plain `Error("owned block … differs from generated content")` when a
user has hand-edited an owned block. `main.ts` only catches `PluginError`, so `akf plugin add`
/ `akf init --plugins` on a drifted block dumps an uncaught stack trace. This is the designed
"refuse drift" path — it deserves a clean one-line error. Either throw a `PluginError` from the
call site or widen the catch.

### 1.3 `runClean` and `runEject` don't catch `ConfigError`

`up`, `build`, and `doctor` all wrap `resolveConfig` in a try/catch and print
`akf <cmd>: <message>`. `clean.ts:30` and `eject.ts:34` call it bare — a malformed
`.apfelkaefig.json` produces a stack trace from exactly the two commands a user might run to
clean up after a broken config. Same three-line catch fixes both.

### 1.4 `akf statusline` can never update an existing script (statusline.ts:23)

`writeIfMissing` means a statusline script installed once is frozen forever — newer releases
(e.g. the recent `(caged)` → `(sandboxed)` change) silently don't propagate; the command prints
"skipped (exists)" with no `--force`. Since the script is fully akf-owned (not user-merged
content), overwrite-by-default or a `--force` flag would be more correct than write-once.

### 1.5 `eject` silently drops `claudeConfigDir`

Both eject paths hardcode the `.claude` source: `defaultMountStrings()` (eject.ts:314-320)
emits `${localEnv:HOME}/.claude`, and `defaultBindMountsFor()` (eject.ts:322-330) emits
`$HOME/.claude`. A project using `claudeConfigDir: "~/.claude-work"` changes Claude profile
after ejecting, with no warning. Either render the resolved dir into the ejected artifacts or
print a warning during eject.

### 1.6 Crit plugin advertises a port-publish path known to be broken on `container` 0.12

`crit`'s post-apply message promises the UI at `http://127.0.0.1:3247`, but per the project's
own findings, Apple `container` 0.12's `-p` host→VM relay is broken (use the VM IP instead).
`akf doctor` checks `container >= 0.9` and says nothing about this. Suggestion: when the
resolved config has `ports` and `container --version` is 0.12, emit a doctor `warn` with the
VM-IP workaround; consider softening the crit message.

### 1.7 Minor robustness nits

- `registry.ts:23` `startRegistry` ignores the exit code of `docker run`; if :5555 is taken by
  a non-docker process, the failure surfaces later as a confusing `docker push` error.
- `build.ts:140` ignores the exit code of `docker tag`.
- `buildRunArgs` (container.ts:139-143) silently drops env entries whose substituted value is
  empty (e.g. `${localEnv:UNSET_VAR}`). Intentional for defaults, but it also swallows
  deliberate `FOO: ""` config entries with no warning.

---

## 2. Architecture & extensibility

### 2.1 The plugin abstraction leaks into config.ts — biggest structural issue

`BuiltInPlugin` (plugins/types.ts) is a nice interface: defaults, applyConfig, marker blocks,
Dockerfile blocks, doctor checks, setup steps. But adding a plugin today requires touching
**five** places:

1. `cli/plugins/<id>/plugin.ts` (the implementation)
2. `REGISTRY` in `cli/lib/plugins.ts`
3. `PluginConfigMap` + per-plugin interfaces in `cli/lib/schema.ts`
4. `validatePluginConfig` in `cli/lib/config.ts` — ~100 lines (config.ts:328-429) of
   hand-written, per-plugin `if (id === "crit") … if (id === "telegram") …` validation
5. `schema/v1.json`

Items 3-5 triplicate the same shape information. The validation in (4) is the worst offender:
it lives in the one file that should be plugin-agnostic, and it will grow linearly with every
plugin. Suggested fix: add `validateConfig?(raw, sourcePath): void` to `BuiltInPlugin` and have
`validatePlugins` dispatch through the registry. That collapses 4 into 1 and keeps `config.ts`
generic. (3 and 5 are an acceptable manual sync given "hand-maintained, keep in sync" is
already the documented policy for schema.ts.)

### 2.2 Required-const boilerplate in the crit plugin config

`crit` requires `agentIntegration: "claude-code"` and `installMethod: "pinned-release"` —
both const-valued and required (schema/v1.json:170, config.ts:357-362). Required fields that
can only ever hold one value carry zero information; they exist as future-proofing for values
that don't exist yet. Make them optional-with-default and validate-if-present. Today they're
pure friction for hand-written configs (and a YAGNI flag).

### 2.3 Duplicate severity/check types

`doctor.ts:19-25` defines `Severity` + `Check`; `plugins/types.ts:3-9` defines
`PluginCheckSeverity` + `PluginDoctorCheck`. They are structurally identical, and doctor
already pushes one into an array of the other. Define once (plugins/types.ts is the natural
home) and re-export.

### 2.4 `schema/v1.json` is embedded into the binary but never read

`deno task compile` includes `--include ./schema`, yet no runtime code reads it —
`SCHEMA_URL` is just a string pointing at apfelkaefig.com. Either drop the include or use the
embed (e.g. `akf init` could write a local `$schema` path, or doctor could validate against
it). Right now it's dead weight in the compiled binary.

### 2.5 What's good (keep doing this)

- The `Runner` seam (`container.ts:11-19`) is used consistently across every lib and command;
  that's why the test suite covers subprocess behavior without ever shelling out.
- `buildRunArgs` as a pure argv builder, with `up.ts` only doing orchestration, is exactly the
  right split.
- Marker-block ownership with refuse-drift-by-default (`upsertBlock`) is the correct contract
  for generated content — the tests document it well.
- Three-tier model is enforced in code, not just docs (drive-by mode skipping
  Downloads/Desktop mounts at container.ts:114 is the standout example).

---

## 3. Redundant code

### 3.1 Helper duplication across files

| Helper | Copies |
|---|---|
| `pathExists` (async lstat) | config.ts:62, crit/plugin.ts:141 |
| `readTextIfPresent` | crit/plugin.ts:151, telegram/plugin.ts:446 |
| `pathExistsSync` | container.ts:186 (with a dead `if NotFound return false; return false` branch — both arms return false) |
| basename→slug logic | `projectImageTag` (container.ts:207) and `projectStem` (telegram/plugin.ts:184) are character-for-character the same algorithm |
| `STATUS_LABELS` | init.ts:36 and plugin.ts:28, overlapping unions |
| `withTmpDir` | five test files |

None are urgent, but `fs.ts` is the obvious home for the first three, `projectStem` should call
the exported `projectImageTag` slug (or a shared `slugify`), and a tiny `cli/lib/test_util.ts`
would absorb `withTmpDir`.

### 3.2 Dead code

- `container.ts:237-238` — `export { DEFAULTS }` re-export (with a stale comment). Nothing
  imports `DEFAULTS` from container.ts; config.ts imports it from schema.ts directly.
- `secrets.ts:98-107` — `ResolveResult.status` is a five-member union, but no caller reads
  `status` at all (`up.ts` only uses `.token`, doctor uses `findOpToken` directly), and
  `"explicit-on-missing"` is unreachable (that path throws). Either have doctor consume
  `resolveOp` (which would also de-duplicate its 1Password logic) or strip the field.
- `clean.ts:8-18` — two import statements from `../lib/container.ts`; merge.

### 3.3 `ejectDevcontainer` env if/else (eject.ts:70-78)

Both branches set `CLAUDE_CONFIG_DIR`; the conditional only decides whether to spread
`c.env`. Collapse to one object literal with a spread.

### 3.4 `rel()` inconsistency in eject.ts

`writeOrForce` prints paths relative to `Deno.cwd()` (eject.ts:374) while every other print
uses `rel(opts.cwd, …)`. Harmless today (cwd == opts.cwd in practice) but it's the kind of
inconsistency that bites when `cwd` plumbing changes; pass `opts.cwd` down.

### 3.5 Template drift — three base Dockerfiles

`image/Dockerfile` (embedded base), `templates/.devcontainer/Dockerfile` (init --advanced /
--bash), and `templates/build.sh`'s assumptions are siblings that have already drifted:
the template Dockerfile lacks the Node install and `xz-utils`/`fd-find` parity, and
`templates/build.sh` hardcodes `IMAGE_NAME="claude-sandbox"` while everything else uses
`<project>-sandbox` tags. Also, eject's `renderStart` and `templates/start.sh` are two
independent implementations of "render container run flags" (TS codegen vs jq/sed parsing).
Given --bash init is documented as a v0.1→v0.2 migration aid, consider folding the legacy
templates into `eject --bash` output (one renderer) and deleting `templates/build.sh` /
`templates/start.sh`.

### 3.6 Round-trip mount duplication in eject

`ejectDevcontainer` always concatenates `defaultMountStrings()` with `c.mounts`
(eject.ts:55). A config that originated *from* a devcontainer.json (tier-3 fallback) already
contains the `.claude` mount parsed back in, so ejecting again writes it twice. Dedupe by
target, same as `buildRunArgs` does.

---

## 4. Naming & API consistency

- Command entry points: `runUp`, `runBuild`, `runEject`, `runClean`, `runDoctor`,
  `runStatusline`, `runInit` — consistent — but `runPluginCommand` breaks the pattern
  (`runPlugin` would match), and **`runInit` returns `Promise<void>` while every other
  command returns `Promise<number>`**. `dispatchInit` papers over it with a hardcoded
  `return 0`. Make `runInit` return a number.
- `runStatusline()` is the only command taking no options object; for uniformity (and
  testability — it's also the only command reading `$HOME` with no seam) give it
  `{ home?, … }` like `buildRunArgs`'s `homeDir`.
- `WriteStatus` / `AppendStatus` / `UpsertStatus` are three overlapping string unions; an
  enum-like single union (`"created" | "appended" | "updated" | "skipped-exists" |
  "skipped-present"`) with per-function return subsets would remove the
  `Record<WriteStatus | AppendStatus | "updated", string>` contortion at init.ts:36.
- Error classes are consistent (`ConfigError`, `PluginError`, `TruncatedTokenError`,
  `SecretsRequiredError` — all named, all message-first). Good.

---

## 5. Premature optimization check

Genuinely little to flag — the repo errs on the simple side, as intended:

- The content-hashed base tag (`apfelkaefig-base:<hash>`) and the Docker→registry→container
  shuttle look heavyweight but are both *justified* complexity (cache invalidation tied to
  Dockerfile content; documented Apple builder DNS bugs). Keep.
- `djb2Hex` for telegram volume names is appropriately cheap and the collision tradeoff is
  documented. Keep.
- The one candidate: `npm/postinstall.js` hand-rolls HTTPS redirect following (74 lines).
  Node ≥18 (already the engines floor) ships `fetch` with automatic redirects — this could be
  ~20 lines. Cosmetic, deferred-distribution surface anyway.

---

## 6. Docs drift

- **CLAUDE.md** says "six subcommands" `{up,init,build,eject,clean,doctor}` — there are
  eight now (`plugin`, `statusline`). The marker-managed block discipline applies to this
  file too.
- **USAGE in main.ts** doesn't mention `akf up --image <ref>` even though the flag is parsed
  and wired through (`imageOverride`). Either document it or drop it.
- **TODO.md** already tracks the dangling chrome-bridge reference — still dangling.
- `secrets.ts:100` comment "Pretty-printable status for `akf doctor`" is stale (doctor never
  calls `resolveOp`) — see §3.2.

---

## 7. Tests

133 tests, fast (~300ms), no subprocess flakiness thanks to the Runner seam. Coverage is
strong on the pure cores (config validation, argv building, marker blocks, secrets
resolution) and notably tied to real regressions (EBUSY dedupe, ENODEV tty, volume
idempotency) — the test names read like a changelog of production bugs, which is the right
shape for this project.

Gaps, in priority order:

1. **`runUp` orchestration** has zero tests (preflight ordering, rebuild paths, error
   propagation from build/pull/volumes). It's the command users run most; the Runner seam
   makes it testable today.
2. **`runDoctor`** — untested; the severity aggregation and exit-code logic are pure enough.
3. **`telegram/upstreamCheck`** does live `fetch` in doctor with no injection seam; untested
   and untestable as written. Pass a `fetch`-like through `PluginDoctorContext`.
4. **CLI arg dispatch** (main.ts) — the §1.1 bugs live exactly in the untested layer.

---

## 8. Prioritized recommendations

1. Fix `akf up --help` / silent unknown-flag swallowing (§1.1) — real UX trap.
2. Catch `ConfigError` in clean/eject; catch block-drift errors at the CLI boundary (§1.2, §1.3).
3. Move per-plugin validation onto `BuiltInPlugin.validateConfig` (§2.1) — biggest
   extensibility win, deletes ~100 lines from config.ts.
4. Make `akf statusline` overwrite (or add `--force`) (§1.4).
5. Handle `claudeConfigDir` in both eject paths, or warn (§1.5).
6. Delete dead code: `DEFAULTS` re-export, `ResolveResult.status`, duplicate clean.ts import,
   unused schema embed (§3.2, §2.4).
7. Consolidate duplicated helpers into fs.ts / a shared slugify (§3.1).
8. Doctor warning for `ports` + container 0.12 (§1.6).
9. Update CLAUDE.md command count and USAGE `--image` (§6).
10. Add `runUp`/`runDoctor` tests; give `upstreamCheck` a fetch seam (§7).
