// Run sshd inside the sandbox so the Claude Code / Codex desktop apps can
// "Add SSH connection" and drive the agent remotely. Reachable only while
// `akf up --serve` is running (foreground, Ctrl+C to stop) — there is no
// background daemon.
//
// Split of responsibilities:
//   - This plugin owns the IMAGE + CONFIG: it installs openssh-server, drops a
//     minimal sshd config, ships the `/usr/local/bin/akf-sshd` entrypoint, and
//     declares the published port + the persistent host-key volume in
//     .apfelkaefig.json.
//   - `akf up --serve` (cli/commands/up.ts) owns the RUN: it overrides the
//     command to the entrypoint, runs as root non-TTY so logs stream, injects
//     the authorized public key as env, and prints the connection banner.
//
// The authorized key is passed at run time as AKF_SSH_AUTHORIZED_KEY (a public
// key — not secret) rather than mounted, so it works regardless of whether
// Apple `container` supports single-file bind mounts.
//
// The host key persists in a per-project named volume (/var/lib/akf-ssh). The
// `--serve` endpoint is a stable 127.0.0.1:<port>, so an ephemeral host key
// would trip known_hosts on every reconnect; persisting it keeps the box's SSH
// identity stable. Everything else stays disposable — `akf clean` drops the
// volume like any other.

import { join } from "@std/path";
import { projectSlug, readTextIfPresent } from "../../lib/fs.ts";
import type { BuiltInPlugin, PluginDoctorCheck, PluginDoctorContext } from "../types.ts";
import { type ApfelkaefigConfig, type MountConfig, VOLUME_NAME_RE } from "../../lib/schema.ts";

const DEFAULT_KEY = "${localEnv:HOME}/.ssh/id_ed25519.pub";
const DEFAULT_PORT = 2222;
const HOST_KEY_DIR = "/var/lib/akf-ssh";
const HOST_KEY = `${HOST_KEY_DIR}/ssh_host_ed25519_key`;
const NODE_USER = "node";
// Desktop apps run their remote server out of ~/.claude/remote and chmod() its
// rpc.sock. ~/.claude is a virtiofs host mount, which rejects chmod on socket
// inodes (EINVAL) — so the daemon dies on startup. Shadowing just this subdir
// with a native (ext4) named volume keeps the socket off virtiofs.
const REMOTE_DIR = `/home/${NODE_USER}/.claude/remote`;
const ENTRYPOINT = "/usr/local/bin/akf-sshd";

interface SshConfig {
  enabled: boolean;
  authorizedKey: string;
  port: number;
  hostKeyVolume?: string;
}

export const sshPlugin: BuiltInPlugin = {
  id: "ssh",
  aliases: [],
  description: "Run sshd in the sandbox so desktop agents can attach over SSH (`akf up --serve`).",
  validateConfig(config) {
    const allowed = ["enabled", "authorizedKey", "port", "hostKeyVolume"];
    for (const k of Object.keys(config)) {
      if (!allowed.includes(k)) {
        throw new Error(`'plugins.ssh' has unknown key '${k}'`);
      }
    }
    if (config.enabled !== true && config.enabled !== false) {
      throw new Error("'plugins.ssh.enabled' must be a boolean");
    }
    if (typeof config.authorizedKey !== "string" || config.authorizedKey.length === 0) {
      throw new Error("'plugins.ssh.authorizedKey' must be a non-empty host path to a public key");
    }
    if (
      typeof config.port !== "number" || !Number.isInteger(config.port) ||
      config.port < 1024 || config.port > 65535
    ) {
      throw new Error("'plugins.ssh.port' must be an integer from 1024 to 65535");
    }
    if ("hostKeyVolume" in config && config.hostKeyVolume !== undefined) {
      if (
        typeof config.hostKeyVolume !== "string" || !VOLUME_NAME_RE.test(config.hostKeyVolume)
      ) {
        throw new Error(`'plugins.ssh.hostKeyVolume' must match ${VOLUME_NAME_RE}`);
      }
    }
  },
  defaultConfig: {
    enabled: true,
    authorizedKey: DEFAULT_KEY,
    port: DEFAULT_PORT,
  },
  applyConfig(base, raw, ctx) {
    const config = raw as unknown as SshConfig;
    if (!config.enabled) return base;

    const hostKeyVol = config.hostKeyVolume ?? `ssh-${projectSlug(ctx.workspaceDir)}-hostkey`;

    const mounts = [...(base.mounts ?? [])];
    if (!mounts.some((m) => m.target === HOST_KEY_DIR)) {
      const vol: MountConfig = { type: "volume", source: hostKeyVol, target: HOST_KEY_DIR };
      mounts.push(vol);
    }
    // Native fs over ~/.claude/remote so the desktop remote server's rpc.sock
    // can be chmod()'d (virtiofs rejects it). Nested inside the ~/.claude host
    // mount — Apple `container` layers the child volume on top correctly.
    if (!mounts.some((m) => m.target === REMOTE_DIR)) {
      const vol: MountConfig = {
        type: "volume",
        source: `ssh-${projectSlug(ctx.workspaceDir)}-remote`,
        target: REMOTE_DIR,
      };
      mounts.push(vol);
    }

    const ports = [...(base.ports ?? [])];
    if (
      !ports.some((p) =>
        p.hostIp === "127.0.0.1" && p.host === config.port && p.container === 22 &&
        (p.protocol ?? "tcp") === "tcp"
      )
    ) {
      ports.push({ hostIp: "127.0.0.1", host: config.port, container: 22, protocol: "tcp" });
    }

    const next: ApfelkaefigConfig = {
      ...base,
      image: { dockerfile: ".devcontainer/Dockerfile" },
      mounts,
      ports,
    };
    return next;
  },
  markerBlocks(_raw) {
    return [{
      path: "CLAUDE.md",
      startMarker: "<!-- akf plugin: ssh start -->",
      endMarker: "<!-- akf plugin: ssh end -->",
      contents: SSH_GUIDANCE,
    }];
  },
  dockerfileBlocks(_raw) {
    return [{
      path: ".devcontainer/Dockerfile",
      startMarker: "# >>> akf plugin: ssh",
      endMarker: "# <<< akf plugin: ssh",
      contents: renderDockerfile(),
    }];
  },
  async doctorChecks(resolved, raw) {
    const config = raw as unknown as SshConfig;
    const checks: PluginDoctorCheck[] = [];
    checks.push(await dockerfileBlockCheck(resolved));
    checks.push(await authorizedKeyCheck(config, resolved.workspaceDir));
    return checks;
  },
  setupSteps(_raw) {
    return [
      {
        command: "akf up --serve --rebuild",
        description: "rebuild the image (bakes in sshd) + start the sandbox (Ctrl+C to stop)",
      },
    ];
  },
  postApplyMessages(raw) {
    const config = raw as unknown as SshConfig;
    return [
      `First run after adding/changing this plugin needs '--rebuild' (or 'akf build'): the`,
      `sshd entrypoint is baked into the image at build time, and 'akf up' reuses the cached`,
      `image otherwise — you'd get "failed to find target executable /usr/local/bin/akf-sshd".`,
      `Reachable over SSH while \`akf up --serve\` is running (foreground; Ctrl+C stops it).`,
      `In the app's "Add SSH connection": Host ${NODE_USER}@127.0.0.1, Port ${config.port}, ` +
      `Identity the private key matching '${config.authorizedKey}'.`,
      `The host key persists across runs so reconnects don't trip known_hosts.`,
    ];
  },
};

// --- doctor checks ---

async function dockerfileBlockCheck(resolved: PluginDoctorContext): Promise<PluginDoctorCheck> {
  const dockerfile = typeof resolved.config.image === "object"
    ? resolved.config.image?.dockerfile
    : undefined;
  if (!dockerfile) {
    return {
      label: "ssh",
      severity: "fail",
      detail: "plugin enabled but image.dockerfile is not configured",
    };
  }
  const path = dockerfile.startsWith("/") ? dockerfile : join(resolved.workspaceDir, dockerfile);
  const text = await readTextIfPresent(path);
  if (!text) {
    return { label: "ssh", severity: "fail", detail: `Dockerfile missing (${path})` };
  }
  return {
    label: "ssh",
    severity: text.includes("# >>> akf plugin: ssh") ? "ok" : "fail",
    detail: text.includes("# >>> akf plugin: ssh")
      ? "Dockerfile block present"
      : "Dockerfile block missing",
  };
}

async function authorizedKeyCheck(
  config: SshConfig,
  workspaceDir: string,
): Promise<PluginDoctorCheck> {
  const path = resolveKeyPath(config.authorizedKey, workspaceDir);
  const text = await readTextIfPresent(path);
  if (text === null) {
    return {
      label: "ssh key",
      severity: "fail",
      detail: `authorizedKey not found: ${path} — connecting will be impossible`,
    };
  }
  if (!/^(ssh-|ecdsa-|sk-)/.test(text.trim())) {
    return {
      label: "ssh key",
      severity: "warn",
      detail: `${path} doesn't look like an OpenSSH public key`,
    };
  }
  return { label: "ssh key", severity: "ok", detail: `authorized key ${path}` };
}

// Resolve ${localEnv:HOME} / ${localWorkspaceFolder} / ~ in the configured key
// path for the doctor's host-side existence check. Mirrors the tokens config.ts
// `substitute` handles on the run path, so doctor agrees with what `akf up` reads.
export function resolveKeyPath(raw: string, workspaceDir = ""): string {
  const home = Deno.env.get("HOME") ?? "";
  let p = raw.replace(/\$\{localEnv:HOME\}/g, home);
  p = p.replaceAll("${localWorkspaceFolder}", workspaceDir);
  if (p.startsWith("~/")) p = `${home}/${p.slice(2)}`;
  return p;
}

// --- dockerfile rendering ---

function renderDockerfile(): string {
  // printf-built files (no heredoc) because the base Dockerfile carries no
  // `# syntax=` directive — matches the telegram plugin's approach.
  return [
    `# Root for the install/config steps below: this block may be appended after a`,
    `# Dockerfile that ended as a non-root user (e.g. a project Dockerfile ending`,
    `# 'USER node'). Runtime user is set separately via 'container run -u', so the`,
    `# trailing build user here doesn't affect how the sandbox runs.`,
    `USER root`,
    ``,
    `# Install sshd so the box is reachable for \`akf up --serve\`. Drop the`,
    `# package-generated host keys: the persistent one in ${HOST_KEY_DIR} (a named`,
    `# volume) is authoritative, generated on first --serve and reused thereafter.`,
    `RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && \\`,
    `    rm -rf /var/lib/apt/lists/* && \\`,
    `    rm -f /etc/ssh/ssh_host_*`,
    ``,
    `# Minimal, pubkey-only sshd config. UsePAM no keeps auth self-contained (no`,
    `# PAM stack needed). The entrypoint unlocks '${NODE_USER}' (\`passwd -d\`) because`,
    `# with UsePAM no, sshd runs its own locked-account check and refuses any`,
    `# account whose shadow password is '!' (the default for a passwordless user).`,
    `RUN printf '%s\\n' \\`,
    `    'PasswordAuthentication no' \\`,
    `    'PermitRootLogin no' \\`,
    `    'UsePAM no' \\`,
    `    'AuthorizedKeysFile /home/${NODE_USER}/.ssh/authorized_keys' \\`,
    `    'HostKey ${HOST_KEY}' \\`,
    `    > /etc/ssh/sshd_config.d/akf.conf`,
    ``,
    `# Entrypoint (the command \`akf up --serve\` runs): ensure the host key exists`,
    `# in the persistent volume, install the authorized key injected via env, then`,
    `# exec sshd in the foreground (-D) logging to stderr (-e) so logs stream.`,
    `RUN printf '%s\\n' \\`,
    `    '#!/bin/sh' \\`,
    `    'set -e' \\`,
    `    'mkdir -p /run/sshd ${HOST_KEY_DIR}' \\`,
    `    'passwd -d ${NODE_USER} >/dev/null' \\`,
    `    'if [ ! -f ${HOST_KEY} ]; then ssh-keygen -t ed25519 -N "" -f ${HOST_KEY}; fi' \\`,
    `    'install -d -m 700 -o ${NODE_USER} -g ${NODE_USER} /home/${NODE_USER}/.ssh' \\`,
    `    'if [ -n "$AKF_SSH_AUTHORIZED_KEY" ]; then' \\`,
    `    '  printf "%s\\\\n" "$AKF_SSH_AUTHORIZED_KEY" > /home/${NODE_USER}/.ssh/authorized_keys' \\`,
    `    '  chown ${NODE_USER}:${NODE_USER} /home/${NODE_USER}/.ssh/authorized_keys' \\`,
    `    '  chmod 600 /home/${NODE_USER}/.ssh/authorized_keys' \\`,
    `    'fi' \\`,
    `    '# The ${REMOTE_DIR} volume mounts root-owned; chown it so ${NODE_USER} can write.' \\`,
    `    '# Desktop apps SFTP the remote server in there, else "Failed to upload file".' \\`,
    `    'chown ${NODE_USER}:${NODE_USER} ${REMOTE_DIR}' \\`,
    `    '# Make claude reachable on the non-interactive PATH. sshd resets the' \\`,
    `    '# environment and ignores the image ENV PATH, so a bare \`ssh host claude\`' \\`,
    `    '# (how desktop apps launch the remote server) cannot find ~/.local/bin/claude.' \\`,
    `    'ln -sf /home/${NODE_USER}/.local/bin/claude /usr/local/bin/claude' \\`,
    `    'exec /usr/sbin/sshd -D -e' \\`,
    `    > ${ENTRYPOINT} && chmod +x ${ENTRYPOINT}`,
  ].join("\n");
}

const SSH_GUIDANCE = `## SSH access to the sandbox

This project enables the akf \`ssh\` plugin. Run:

\`\`\`bash
akf up --serve --rebuild   # first run after enabling/changing the plugin
akf up --serve             # subsequent runs
\`\`\`

The first \`--serve\` after adding or changing this plugin needs \`--rebuild\`
(or a prior \`akf build\`): the sshd entrypoint is baked into the image at build
time, and \`akf up\` reuses the cached image otherwise — without the rebuild you
get \`failed to find target executable /usr/local/bin/akf-sshd\`.

That starts sshd inside the sandbox in the foreground (Ctrl+C stops it) and
prints the connection details. In the desktop app's "Add SSH connection" use
the printed Host / Port / Identity — the app runs the agent inside this box
over SSH.

Reachability is local-only: the port is published on \`127.0.0.1\`, and the
host key persists across runs so reconnects don't trip \`known_hosts\`.

### Troubleshooting the desktop attach

- **"Failed to connect to agent"** — your SSH keys are served by the **1Password
  SSH agent**, which stops responding ("connection refused") whenever 1Password
  is locked or closed. The desktop app surfaces that as this error. Fix: open and
  unlock 1Password, then "Try again". (Lengthen Settings → Security → auto-lock if
  it keeps happening.)
- **"All configured authentication methods failed"** — the key the app offers
  isn't in the sandbox's \`authorized_keys\`. \`authorizedKey\` must point at a file
  holding the public key the app's agent serves (here: the 1Password keys in the
  gitignored \`.devcontainer/authorized_keys.pub\`).
- **"Failed to start remote server" / "claude-ssh: timeout"** — \`claude\` not on
  the non-interactive PATH; the entrypoint symlinks it into \`/usr/local/bin\`.
- **"Failed to upload file: No such file"** — the \`~/.claude/remote\` named volume
  mounts root-owned, so \`node\` can't SFTP the remote server into it. The entrypoint
  \`chown\`s it to \`node\`; if you see this, the rebuild didn't pick up that fix.
- **"chmod socket: invalid argument"** (in \`~/.claude/remote/run/<id>/remote-server.log\`)
  — \`~/.claude/remote\` landed on virtiofs (the host mount), which rejects chmod on
  socket inodes. A native named volume shadows that subdir to fix it.

Diagnose from the host with \`container logs akf-serve-<projectSlug>\` (sshd auth)
and, inside the box, \`~/.claude/remote/run/<id>/remote-server.log\` (daemon).`;
