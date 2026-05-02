# Plan: 005 — Named-volume mounts (`mounts[].type: "volume"`)

## Context

`mounts[]` today only expresses **bind** mounts. The schema validates `source`/`target`/`readonly`
([schema/v1.json:39-61](../schema/v1.json), [cli/lib/config.ts:153-172](../cli/lib/config.ts)) and
renders them as `-v src:tgt[:ro]` after a `pathExistsSync` check
([cli/lib/container.ts:86-95](../cli/lib/container.ts)).

This breaks for any project that legitimately wants persistent state **scoped to the VM**, never
under host `$HOME`. Concrete trigger: the `_daily_work` migration off `build.sh`/`start.sh` — that
repo uses two Apple-Container named volumes (`telegram-auth-config`, `telegram-auth-state`) so
Telegram session tokens never land on the host filesystem. With bind mounts only, that property
regresses to "tokens live in `~/.local/share/...`".

Generalising `mounts[]` with an optional `type: "bind" | "volume"` field — defaulting to `"bind"` —
unblocks this case without expanding the schema's surface area, and leaves room for `tmpfs` later
behind the same discriminator.

Out of scope: a generic pre-up hook system. That's a bigger design conversation; this change is the
minimum to unblock named-volume use cases and is independently useful.

---

## Design

### Schema shape

```jsonc
"mounts": [
  // Bind (existing, unchanged):
  { "source": "${localEnv:HOME}/.config/gh", "target": "/home/node/.config/gh" },

  // Volume (new):
  { "type": "volume", "source": "telegram-auth-config",
    "target": "/home/node/.config/telegram-cli" }
]
```

Rules:

- `type` is optional; absence means `"bind"` (full backward compat).
- For `type: "volume"`:
  - `source` must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (Apple Container volume-name conventions).
  - `${...}` substitutions in `source` are rejected (volume names are literal).
  - `pathExistsSync` is **not** run (source is not a host path).
  - akf pre-creates the volume idempotently before `container run`.
- `readonly: true` is honoured for both types.

### Runtime behaviour (`akf up`)

`commands/up.ts` calls a new `ensureVolumes(mounts)` between image resolution and `container run`.
The helper shells out to `container volume create <name>` once per unique volume source, swallowing
"already exists" errors.

`lib/container.ts` mount loop branches on `m.type ?? "bind"`:

- bind: existing behaviour (unchanged).
- volume: append `--volume`, `${m.source}:${tgt}${m.readonly ? ":ro" : ""}`. Skip the
  `pathExistsSync` check.

### Eject paths

`commands/eject.ts`:

- **`--bash`** ([eject.ts:189-216](../cli/commands/eject.ts)): for each volume mount, emit a
  `container volume create <name> >/dev/null 2>&1 || true` line near the script header, and
  `mount_flags+=(-v "<name>:<target>[:ro]")` in the run step.
- **`--devcontainer`** ([eject.ts:300, `mountObjToString`](../cli/commands/eject.ts)): emit
  `source=<name>,target=<tgt>,type=volume[,readonly]`. devcontainer.json supports `type=volume`
  natively, so no further coordination is needed on the IDE side.

### Devcontainer import (round-trip)

`cli/lib/config.ts:332-353` (`parseDevcontainerMount`) currently throws away `type=volume` strings
since it only retains `source`/`target`/`readonly`. Update it to set `type: "volume"` on the
resulting `MountConfig` when the mount string contains `type=volume` — preserves round-trip fidelity
for users who already have devcontainer.json with named volumes.

---

## Files to change

| File                                             | Change                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `schema/v1.json`                                 | Add `type` enum to `mounts.items.properties`; update description for the field.                        |
| `cli/lib/schema.ts:7-11`                         | Add `type?: "bind" \| "volume"` to `MountConfig`.                                                      |
| `cli/lib/config.ts:153-172`                      | Allow `type` key; validate enum + volume-name regex; reject substitutions in volume `source`.          |
| `cli/lib/config.ts:332-353`                      | Preserve `type: "volume"` when importing devcontainer mount strings.                                   |
| `cli/lib/container.ts:86-95`                     | Branch on `m.type`; render `--volume` syntax for volumes; bypass `pathExistsSync`.                     |
| `cli/lib/container.ts` (new helper)              | `ensureVolumes(mounts)` that calls `container volume create` per unique volume name.                   |
| `cli/commands/up.ts:76-107`                      | Call `ensureVolumes(c.mounts ?? [])` after image resolution, before `container run`.                   |
| `cli/commands/eject.ts:189-216`                  | Emit `container volume create` lines + `-v name:tgt` flags for volume mounts in the bash output.       |
| `cli/commands/eject.ts:300` (`mountObjToString`) | Emit `type=volume` instead of `type=bind` when appropriate.                                            |
| `templates/.apfelkaefig.json`                    | Add a commented-out `type: "volume"` example to the `mounts` block so `akf init` users see the option. |

## Tests

| File                                                                                 | Add                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/lib/config_test.ts:66-76` (next to existing mount tests)                        | Accept `{ type: "volume", source: "tg-auth", target: "/x" }`. Reject: invalid volume name (`"foo bar"`, `"$HOME"`), substitutions in volume source, unknown `type` value. |
| `cli/lib/config_test.ts:183-197`                                                     | Round-trip: importing a devcontainer mount string `source=foo,target=/x,type=volume` should yield `{ type: "volume", source: "foo", target: "/x" }`.                      |
| `cli/lib/container_test.ts`                                                          | Render test: a volume mount produces `--volume name:target` and skips the host-path check.                                                                                |
| `cli/lib/container_test.ts` (new)                                                    | `ensureVolumes` integration test (mock `container` CLI) — confirms idempotent create, swallows "already exists".                                                          |
| `cli/commands/eject.ts` (covered via existing eject tests if present, otherwise add) | `eject --bash` output includes `container volume create` line + correct `-v` flag.                                                                                        |

## Build & ship

1. `cd /Users/schmidsi/Workbench/apfelkaefig`
2. `deno test` — all tests pass.
3. `./build.sh` (or whatever produces `dist/akf`).
4. The `~/.local/bin/akf` symlink picks up the new binary; verify with `akf --version` (bump from
   0.2.0-dev to e.g. 0.2.1-dev or 0.3.0-dev as appropriate).
5. Bump `version` in `deno.json` / `npm/` if shipping.

## Verification

In a throwaway repo:

```jsonc
// .apfelkaefig.json
{
  "$schema": "https://apfelkaefig.com/schema/v1.json",
  "version": 1,
  "mounts": [
    { "type": "volume", "source": "akf-test-vol", "target": "/data" }
  ]
}
```

1. `akf doctor` — clean.
2. `akf up -- bash` — drops into shell.
3. Inside: `mount | grep /data` shows the named volume; `echo hello > /data/x` succeeds.
4. Exit, `akf clean`, `akf up -- bash` again — `cat /data/x` still says `hello` (volume persisted).
5. `container volume ls | grep akf-test-vol` — confirms the volume is real.
6. `akf eject --bash --force` — generated `start.sh` contains `container volume create akf-test-vol`
   and `-v akf-test-vol:/data`.
7. `akf eject --devcontainer --force` — generated `devcontainer.json` mount string includes
   `type=volume`.
8. Cleanup: `container volume rm akf-test-vol`.

## Downstream

Unblocks `_daily_work/tasks/001-migrate-to-apfelkaefig.md`. No other known consumers.
