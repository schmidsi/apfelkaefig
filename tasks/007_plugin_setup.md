# Plan: 007 — Plugin interactive bootstrap

## Context

After `akf init --plugins telegram` (or `akf plugin add telegram`), the user still has two
interactive commands to run before Telegram works:

```
akf up -- telegram setup
akf up -- telegram auth
```

Crit has the same pattern (`akf up -- crit install claude-code`). Today we surface these as numbered
"Next steps" in init / plugin add output (task 007 phase 0, already shipped). That helps with
discoverability, but the user still has to:

1. Read the steps.
2. Remember to exit Claude (the default `akf up` launches Claude, not a shell).
3. Run each bootstrap command from the host.
4. Run `akf up` again to actually start working.

It's three rituals that all live outside akf. Two improvements:

- **(A)** `akf plugin setup <id>` — one command that runs the plugin's interactive bootstrap and
  exits.
- **(B)** Auto-detect "not bootstrapped" on `akf up` and offer to run setup.

(B) is the warmer UX but requires runtime probing of plugin state. (A) is strictly an ergonomic
improvement on what users already do manually.

## Out of scope

- Non-interactive plugin bootstrap (1Password's token is already handled by `secrets.onepassword` +
  `findOpToken`; not a plugin-setup concern).
- Removing the manual `akf up -- ...` path. It stays as the underlying primitive; `akf plugin setup`
  is just a wrapper.
- Multi-plugin orchestration (running setup for several plugins in one invocation). If multiple
  plugins are added, the user runs `akf plugin
  setup <id>` per plugin. Cheaper than designing a
  sequencer.

---

## (A) `akf plugin setup <id>`

### CLI

```bash
akf plugin setup telegram      # run all setupSteps for telegram interactively
akf plugin setup telegram --skip-if-configured  # no-op if isBootstrapped() returns true
```

`--skip-if-configured` lets the auto-detect path in (B) reuse the same code.

### BuiltInPlugin extension

```ts
interface BuiltInPlugin {
  // existing fields …
  setupSteps?: (config) => SetupStep[]; // already shipped
  isBootstrapped?: (ctx, config) => Promise<boolean>; // new, for (B)
}
```

`SetupStep.command` is already an `akf up -- …` invocation today. For `akf plugin setup`, we should:

- Parse the `akf up --` prefix off the command string OR (cleaner) introduce a
  `SetupStep.containerCommand: string[]` and let `setupSteps()` return the underlying args. The
  current string form is for display only; `akf plugin
  setup` ought to run the args without
  re-shelling.

Recommended: split `SetupStep` into:

```ts
interface SetupStep {
  containerArgv: string[]; // ["telegram", "setup"]
  description: string; // "API credentials from my.telegram.org"
}
```

Display string becomes `akf up -- ${argv.join(" ")}` rendered at print time. `akf plugin setup` runs
each step via the same path `akf up -- argv` uses.

### Behavior

For each step in order:

1. Print `→ Running: akf up -- {argv}  # {description}`.
2. Invoke `runUp({ positional: argv, … })` with TTY allocated.
3. If exit code != 0, abort and print "Setup failed at step N. Re-run `akf plugin setup <id>` once
   the issue is resolved."
4. After last step, print "Setup complete."

Edge cases:

- User interrupts (Ctrl-C) → propagate exit cleanly; next run resumes from step 1 (idempotency is
  the plugin's responsibility — `telegram setup` doesn't blow away existing config).
- Plugin not enabled → error: "plugin '<id>' is not enabled in .apfelkaefig.json; run
  `akf plugin add <id>` first."

### Tests

- `akf plugin setup telegram` invokes the runner with the expected argv pair (fake runner asserts
  both `telegram setup` and `telegram auth` were invoked, in order).
- Aborts on non-zero exit from step 1; step 2 is not invoked.
- `--skip-if-configured` short-circuits when `isBootstrapped` returns true.

---

## (B) Auto-detect on `akf up`

### Plugin contract

```ts
isBootstrapped?: (
  ctx: { workspaceDir: string },
  config: Record<string, unknown>,
) => Promise<boolean>;
```

For telegram:

- `storage=instance|named` → probe the named volume for the session file. The probe runs inside the
  sandbox: `container run --rm -v <vol>:/check
  <image> test -f /check/telegram.session`. Slow-ish
  (a few seconds), so the result is cached for the duration of the `akf up` invocation, not across
  runs.
- `storage=host` → `Deno.lstat($HOME/.local/state/telegram-cli/telegram.session)` on the host. Fast.

For crit:

- Check whether `.claude-plugin/` exists in the workspace. Fast — no container probe needed.

### `akf up` flow change

Before launching the main container:

1. For each enabled plugin with `isBootstrapped`, run the check.
2. For each `false` result, prompt:
   ```
   Plugin 'telegram' has not been bootstrapped yet.
   Run setup now? [Y/n]
   ```
3. On `Y` (default), invoke the same path as `akf plugin setup <id>`.
4. On `n`, continue to `akf up` as today (user gets the "missing credentials" error from the CLI
   when they try to use it — same as today).
5. After all checks/setups complete, proceed with normal `akf up`.

Non-interactive `akf up` (e.g. `akf up -- some-command` for scripting): skip the prompt and just
emit a `[warn]` line. Don't break automation.

### Performance

The volume probe is the slow case. Two ways to keep `akf up` fast:

- **Lazy probe.** Only probe when there's a TTY (interactive use). Scripted `akf up -- …` skips
  probing entirely. Trade-off: scripted users don't get the warning either.
- **Cache result on the volume.** Drop a `.akf-bootstrapped` marker file into the volume after
  successful setup. `isBootstrapped` becomes a check for the marker on the host side (via
  `container volume inspect` or similar). Fast, but adds plugin-managed state to volumes.

Recommend lazy probe for v1, marker file later if probes prove painful.

### Tests

- `akf up` in a fresh project with telegram plugin enabled and no session prompts setup; setup runs
  through; `akf up` then proceeds.
- `akf up` declines (`n`) → `akf up` proceeds without setup.
- `akf up -- somecmd` (scripted) does not prompt; emits warning instead.
- Volume probe is gated by TTY check.

---

## Rollout

1. Land (A) first. It's a strict improvement on the current "read three notes and remember them" UX.
2. Add `isBootstrapped` to telegram and crit. No behavior change yet — just the predicate.
3. Land (B). Gate behind a feature flag (`AKF_PLUGIN_AUTOSETUP=1`) for one release cycle, then on by
   default.

Both phases are additive to the existing plugin interface; no breaking changes to
`.apfelkaefig.json` schema or to any of the plugin Dockerfile / marker block contracts.
