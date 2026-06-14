# Plan: 010 — SSH-reachable käfig (`ssh` plugin + `akf up --serve`)

## Context

The Claude Code desktop/web app (and Codex, Cursor, …) can "Add SSH connection" — *connect to a
remote machine to run Claude Code*. The app stays local; only the **agent process** runs on the
remote, reached over SSH. An apfelkäfig micro-VM is exactly that kind of remote: it already ships
the agent in the image (`image/Dockerfile:42-44`), already has the mounts and the hermetic story.

Today `akf up` (`cli/commands/up.ts:156-178`) execs `container run` with the TTY inherited: the
agent runs *inside* the VM and you drive it through your terminal — one ephemeral interactive
session. The SSH model inverts that: the box runs `sshd`, the native app attaches over SSH, and your
terminal does something else entirely.

This task adds that "something else": a **foreground server mode**. Not a background daemon —
`akf up --serve` runs in the foreground, streams sshd's logs, and `Ctrl+C` tears it down. Same
lifecycle muscle-memory as `vite` / `next dev` / `docker compose up` (no `-d`). There is deliberately
**no detach, no `stop`/`status` command, no orphaned container** — the lifecycle is "the terminal is
open."

### The seam: plugin vs. core

The plugin system (`cli/lib/plugins.ts`, `cli/plugins/types.ts`) composes the **image and config**:
a plugin injects marker-managed Dockerfile blocks, mutates `.apfelkaefig.json` (mounts, ports,
`image.dockerfile`), and prints `setupSteps` + `postApplyMessages` on add. It **cannot** touch how
`container run` is invoked. The detached-vs-foreground, command-override, TTY decisions live in
`runUp` / `buildRunArgs`. So the work splits cleanly along that seam:

- **`ssh` plugin** — owns `sshd` in the image, the authorized-key mount, the persistent host-key
  volume, the published port, and the "here's how to connect" messaging. Opt-in via
  `akf plugin add ssh`. Models exactly on `cli/plugins/telegram/plugin.ts`.
- **`akf up --serve`** — the thin foreground run-mode: overrides the in-container command to the
  sshd entrypoint, runs non-TTY so stdout/stderr stream as logs, prints a connection banner, and
  reuses the existing spawn-and-forward-SIGINT path (`up.ts:156-178`) verbatim for teardown.

They compose: `akf plugin add ssh` once, then `akf up --serve` whenever you want the box reachable.

## Out of scope

- **Auto-editing `~/.ssh/config`.** akf only writes files it owns; the user's curated SSH config is
  on the wrong side of that line (a bad render there can lock you out of *other* hosts). The plugin
  **prints** connection details for the app's explicit Host/Port/Identity fields. A managed
  `Include` file is a possible future follow-up, not this task.
- **A background daemon / `akf daemon` command.** Explicitly rejected — foreground only. No
  detach, no `stop`/`status`. Revisit only if a real reconnect-lifecycle need appears.
- **ghcr.io base-image distribution.** Unchanged (`TODO.md`); `sshd` is added via the project
  `.devcontainer/Dockerfile` block like every other plugin, not baked into the embedded base.
- **Multi-key / SSH CA / agent-forwarding.** One authorized public key, path-configurable. Enough to
  connect the app.
- **Verifying which SSH library the app uses.** Whether the desktop app shells out to system `ssh`
  (honors `~/.ssh/config`) or uses its own is a real open question, but it does not block this task:
  the explicit Host/Port/Identity fields in the dialog work regardless. Noted under Edge cases.

## Design

### Layer 1 — the `ssh` plugin (`cli/plugins/ssh/plugin.ts`)

Mirror the telegram plugin's shape (`BuiltInPlugin` in `cli/plugins/types.ts:32-60`). Config:

```ts
interface SshConfig {
  enabled: boolean;
  authorizedKey: string; // host path to a PUBLIC key; default ${localEnv:HOME}/.ssh/id_ed25519.pub
  port: number;          // host port to publish container :22 on; default 2222
  hostKeyVolume?: string;// named volume for persistent host key; default derived from workspace
}
```

- **`defaultConfig`** → `{ enabled: true, authorizedKey: "${localEnv:HOME}/.ssh/id_ed25519.pub",
  port: 2222 }`.
- **`validateConfig`** → reject unknown keys (telegram pattern, `telegram/plugin.ts:57-97`);
  `port` an integer in 1024–65535; `authorizedKey` a non-empty string; `hostKeyVolume` (if set)
  matches `VOLUME_NAME_RE`.
- **`applyConfig`** (model on `telegram/plugin.ts:107-142`):
  - Set `image = { dockerfile: ".devcontainer/Dockerfile" }` (plugins that add Dockerfile blocks
    require tier-2; telegram does the same).
  - Add a **bind mount** of the public key to a read-only staging path:
    `{ type: "bind", source: authorizedKey, target: "/run/akf/authorized_keys", readonly: true }`.
    Staging + entrypoint-copy (below) sidesteps sshd `StrictModes` ownership/permission checks that a
    raw read-only virtiofs mount at `~/.ssh/authorized_keys` would trip.
  - Add a **named volume** for the host key:
    `{ type: "volume", source: <hostKeyVol>, target: "/var/lib/akf-ssh" }`, where `<hostKeyVol>`
    defaults to `ssh-${projectSlug(workspaceDir)}-hostkey` (reuse `projectSlug` from
    `cli/lib/fs.ts`, as telegram does at `telegram/plugin.ts:214`). This is the *persistent host
    identity* — see "Host-key persistence" below.
  - Add the **published port**: `ports: [{ hostIp: "127.0.0.1", host: port, container: 22 }]`
    (schema already supports `ports`; emitted by `buildRunArgs` at `container.ts:74-78`). Publishing
    to `127.0.0.1` keeps the endpoint **stable** (`localhost:<port>`) regardless of the per-run
    container IP, and keeps sshd off any non-loopback host interface.
- **`dockerfileBlocks`** → one block in `.devcontainer/Dockerfile`
  (markers `# >>> akf plugin: ssh` / `# <<< akf plugin: ssh`) that:
  - `apt-get install -y --no-install-recommends openssh-server`.
  - Writes `/etc/ssh/sshd_config.d/akf.conf`:
    ```
    PasswordAuthentication no
    PermitRootLogin no
    AuthorizedKeysFile /home/node/.ssh/authorized_keys
    HostKey /var/lib/akf-ssh/ssh_host_ed25519_key
    ```
  - Installs an entrypoint `/usr/local/bin/akf-sshd` (the command `--serve` runs) that:
    1. `mkdir -p /var/run/sshd /var/lib/akf-ssh`.
    2. If `/var/lib/akf-ssh/ssh_host_ed25519_key` is absent, `ssh-keygen -t ed25519 -N "" -f` it
       (first run in a fresh host-key volume; persists thereafter).
    3. Copy `/run/akf/authorized_keys` → `/home/node/.ssh/authorized_keys`, `chown node:node`,
       `chmod 700 ~/.ssh` + `600 authorized_keys` (satisfies sshd `StrictModes`).
    4. `exec /usr/sbin/sshd -D -e` — `-D` foreground (so it's PID-1-ish and `Ctrl+C` reaches it),
       `-e` logs to stderr (so the host terminal streams connection logs).
  - The named volume mounts root-owned (Apple container behavior, see telegram's chown notes at
    `telegram/plugin.ts:341-368`); the entrypoint runs as root and chowns as needed, so no
    image-time ownership dance is required for `/var/lib/akf-ssh`.
- **`doctorChecks`** → (a) Dockerfile block present (reuse the telegram `dockerfileBlockCheck`
  shape, `telegram/plugin.ts:375-398`); (b) `authorizedKey` file exists on the host and looks like a
  public key (`fail` if missing — connecting is impossible without it).
- **`setupSteps`** → `{ command: "akf up --serve", description: "start the SSH-reachable sandbox" }`.
- **`postApplyMessages`** → the connection guidance, e.g.:
  ```
  Reachable over SSH while `akf up --serve` is running.
  In the app's "Add SSH connection": Host node@127.0.0.1, Port <port>, Identity <private key>.
  Host key persists in volume '<hostKeyVol>' so reconnects don't trip known_hosts.
  ```

Register it: add `sshPlugin` to the `REGISTRY` in `cli/lib/plugins.ts:17-21` and the `PluginConfigMap`
in `cli/lib/schema.ts` (+ `schema/v1.json`), following the telegram precedent (grep
`"telegram"` across `cli/lib/schema.ts` and `schema/v1.json` and mirror every hit).

### Layer 2 — `akf up --serve` (foreground run-mode)

- **`cli/main.ts`** — `parseUpArgs` (`main.ts:97-123`): add `"serve"` to the `boolean` list
  (`main.ts:101`), thread `serve: flags.serve` through the `UpArgs` `"run"` variant (`main.ts:95`,
  `:117-122`) and `dispatchUp` → `runUp` (`main.ts:135-140`). Update `USAGE` (`main.ts:16-18`) to
  document `[--serve]`.
- **`cli/commands/up.ts`** — add `serve?: boolean` to `UpOptions` (`up.ts:20-32`). When `serve`:
  - Override the in-container command to `["/usr/local/bin/akf-sshd"]` and force **non-TTY** so
    stdout/stderr stream as logs.
  - Print a connection banner to stderr *before* spawning (Host/Port/Identity, pulled from the
    resolved `ssh` plugin config), then "logs follow; Ctrl+C to stop".
  - Spawn / SIGINT-forward path is **unchanged** (`up.ts:156-178`) — that already gives
    "foreground, Ctrl+C kills it", and `--rm` (`container.ts:72`) removes the container on exit so
    nothing is left running.
  - **Guard:** if `--serve` is passed but the `ssh` plugin is not enabled in resolved config, error
    with a one-liner pointing at `akf plugin add ssh` (the entrypoint/port/key won't exist
    otherwise).
- **`cli/lib/container.ts`** — `buildRunArgs` (`container.ts:62-152`) currently appends `e.command`
  (`container.ts:148`) and derives TTY from `input.tty ?? stdinIsTerminal()` (`container.ts:71`).
  Add `commandOverride?: string[]` to `RunFlagsInput`; when present, append it instead of
  `e.command`. `input.tty` already exists — `runUp` passes `tty: false` for serve. No other change;
  the port + mounts come from config (placed there by the plugin), so they flow through untouched.

### Host-key persistence (the one real subtlety)

Because `--serve` publishes a **stable** `127.0.0.1:<port>` endpoint, an *ephemeral* host key would
trip "REMOTE HOST IDENTIFICATION HAS CHANGED" on every reconnect (same host:port, new key). So the
plugin persists the host key in a per-project named volume (`/var/lib/akf-ssh`), generated once and
reused. This is the deliberate "pet, not cattle" choice for the *host identity specifically* — the
workspace and everything else stay disposable; only the box's SSH fingerprint is stable. It's one
named volume, visible in `.apfelkaefig.json` as a mount the user opted into by adding the plugin — no
magic, and `akf clean` can drop it like any other volume.

## Implementation

### New files
- `cli/plugins/ssh/plugin.ts` — the plugin (structure per Design / telegram precedent).
- `cli/plugins/ssh/plugin_test.ts` — unit tests (see Tests).

### Edited files
- `cli/lib/plugins.ts:9-21` — import + register `sshPlugin`.
- `cli/lib/schema.ts` — add `ssh` to `PluginConfigMap` and any `SshStorage`-like exported types
  needed; mirror telegram.
- `schema/v1.json` — add the `plugins.ssh` object schema (mirror `plugins.telegram`). Unknown keys
  are a hard error project-wide, so the schema must enumerate `enabled`, `authorizedKey`, `port`,
  `hostKeyVolume`.
- `cli/main.ts:16-18,95,101,117-140` — `--serve` flag plumbing + USAGE.
- `cli/commands/up.ts:20-32,135-152` — `serve` option, command override, banner, plugin guard.
- `cli/lib/container.ts:62-148` — `commandOverride` in `RunFlagsInput` + append logic.

## Tests

Follow the existing plugin/test conventions (`build_test.ts`, telegram tests, `parseUpArgs` tests).

- **`cli/plugins/ssh/plugin_test.ts`:**
  - `applyConfig` adds the authorized-key bind mount (ro, target `/run/akf/authorized_keys`), the
    host-key volume mount (target `/var/lib/akf-ssh`), the `127.0.0.1:<port>:22` port, and sets
    `image.dockerfile`.
  - `applyConfig` is idempotent — re-applying doesn't duplicate mounts/ports (telegram's `addMount`
    dedup, `telegram/plugin.ts:118-121`).
  - `dockerfileBlocks` emits the `# >>> akf plugin: ssh` markers and contains `openssh-server`,
    `sshd -D -e`, and the host-key path.
  - `validateConfig` rejects an out-of-range `port` and unknown keys.
  - `doctorChecks` returns `fail` when `authorizedKey` is missing.
- **`parseUpArgs`** (wherever `main.ts` parsing is tested): `--serve` sets `serve: true`; absent →
  `false`; `--serve` is not mistaken for a positional.
- **`runUp` serve behavior** (using the injectable `Runner`/`run` seam in `UpOptions`): with the ssh
  plugin enabled and `serve: true`, the spawned `container run` argv contains `-i` (not `-it`), the
  published port, and ends with `/usr/local/bin/akf-sshd` (not the default agent command). Without
  the ssh plugin, `--serve` errors before spawning.
- `deno task test`, `deno task lint`, `deno task fmt --check` all green.

## Edge cases

- **Does Apple `container` actually publish `-p` ports to the host?** The schema and `buildRunArgs`
  already emit `-p`, so it's an existing feature — but confirm `127.0.0.1:2222:22` is reachable from
  the host on `container 1.0`. If host publishing is unreliable, fall back to connecting at the
  container's own vmnet IP (`container ls` / `inspect`) and print *that* in the banner instead — the
  rest of the design is unchanged, only the banner's Host value differs.
- **App's SSH config support.** If the desktop app shells out to system `ssh`, `~/.ssh/config` and
  `known_hosts` behave normally; if it uses its own SSH library, the explicit dialog fields still
  work. Either way the banner gives literal Host/Port/Identity, so nothing here depends on the app
  reading `~/.ssh/config`.
- **`StrictModes` / key perms.** Why the entrypoint copies the key rather than mounting it straight
  onto `~/.ssh/authorized_keys`: a read-only virtiofs mount may not satisfy sshd's owner/permission
  checks. The copy + `chown node:node` + `chmod 600` is the robust path; keep it.
- **`Ctrl+C` actually stops sshd.** `sshd -D` foreground exits on SIGINT/SIGTERM; the existing
  forwarder (`up.ts:163-170`) sends SIGINT to the `container run` child. Confirm the signal reaches
  PID 1 and the container exits (with `--rm`, it's then removed). If it lingers, the entrypoint can
  `trap` and `exec` so signals propagate — but a plain `exec sshd -D` should already be PID 1.
- **First `--serve` on a fresh host-key volume** generates the key (a one-time `ssh-keygen` line in
  the log) — not an error.
- **Missing public key.** If `~/.ssh/id_ed25519.pub` doesn't exist, the bind mount source is absent;
  `buildRunArgs` warns and skips missing bind sources (`container.ts:104-106`), so sshd would start
  with no authorized key and reject all logins. The doctor `fail` check is the guard; consider also
  erroring in `runUp` serve-mode if the resolved authorized-key path doesn't exist, to fail loud
  before the app tries to connect.

## Rollout

1. Branch (`git checkout -b 010-ssh-serve`).
2. Implement the `ssh` plugin + registry/schema wiring; `akf plugin add ssh` renders the Dockerfile
   block and config.
3. Implement `--serve` plumbing (`main.ts` → `up.ts` → `buildRunArgs`).
4. `deno task test` green.
5. Manual smoke **on the host** (nested `container` inside an apfelkäfig is not guaranteed):
   - `akf plugin add ssh && akf up --serve` → banner prints, sshd logs stream.
   - From the host: `ssh -p 2222 node@127.0.0.1` connects with the default key.
   - Add the connection in the Claude Code app using the banner's fields; confirm it drives the
     agent inside the box.
   - `Ctrl+C` → sshd stops, container is gone (`container ls -a` shows nothing).
   - Reconnect after a second `akf up --serve` → **no** known_hosts conflict (host key persisted).
6. Docs: `README.md` (three-tier section — `--serve` is the SSH-reachable mode), and a short
   `docs/` note if the connection flow needs a screenshot.
7. Commit autonomously (`simon+agent` identity, `commit.gpgsign=false`).
