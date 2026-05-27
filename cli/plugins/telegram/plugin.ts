// Install gskril/telegram-cli inside the sandbox with per-project isolated
// session storage. Three storage modes:
//
//   instance — named volumes derived from the workspace absolute path. Each
//              clone of the repo gets its own session; not shared.
//   named    — named volumes derived from the workspace basename, written
//              into .apfelkaefig.json as literals. Clones of the same repo
//              on the same host share one session.
//   host     — bind-mount the host's ~/.config/telegram-cli and state dir.
//              No isolation from host; useful when the host already runs
//              the CLI and you want to reuse the session.
//
// userIsolation=true installs a dedicated `telegram` system user inside the
// container; the agent user (`node`) reaches the CLI only through
// `sudo -u telegram`, so claude-running-as-node can invoke telegram but
// cannot read the session DB directly. Incompatible with storage=host.

import { basename } from "@std/path";
import type {
  BuiltInPlugin,
  PluginContext,
  PluginDoctorCheck,
  PluginDoctorContext,
} from "../types.ts";
import type { ApfelkaefigConfig, MountConfig, TelegramStorage } from "../../lib/schema.ts";

const DEFAULT_REPO = "https://github.com/gskril/telegram-cli.git";
// Latest gskril/telegram-cli HEAD at plugin time. Bump by hand when the
// upstream doctor check warns "differs from upstream <new>".
const DEFAULT_SHA = "95612b198c449f3768756f7e5ecd075fe6330b07";

const PNPM_VERSION = "10.15.1";

const NODE_USER = "node";
const TELEGRAM_USER = "telegram";

interface TelegramConfig {
  enabled: boolean;
  repo: string;
  sha: string;
  storage: TelegramStorage;
  userIsolation: boolean;
  configVolume?: string;
  stateVolume?: string;
}

export const telegramPlugin: BuiltInPlugin = {
  id: "telegram",
  aliases: ["tg"],
  description: "Install gskril/telegram-cli with per-project isolated session storage.",
  defaultConfig(_ctx) {
    return {
      enabled: true,
      repo: DEFAULT_REPO,
      sha: DEFAULT_SHA,
      storage: "instance" as TelegramStorage,
      userIsolation: false,
    };
  },
  applyConfig(base, raw, ctx) {
    const config = raw as unknown as TelegramConfig;
    if (!config.enabled) return base;

    const targets = mountTargets(config);
    const next: ApfelkaefigConfig = {
      ...base,
      image: { dockerfile: ".devcontainer/Dockerfile" },
    };

    const mounts = [...(next.mounts ?? [])];
    const addMount = (m: MountConfig) => {
      if (mounts.some((x) => x.target === m.target)) return;
      mounts.push(m);
    };

    if (config.storage === "host") {
      addMount({
        type: "bind",
        source: "${localEnv:HOME}/.config/telegram-cli",
        target: targets.configDir,
      });
      addMount({
        type: "bind",
        source: "${localEnv:HOME}/.local/state/telegram-cli",
        target: targets.stateDir,
      });
    } else {
      const { configVol, stateVol } = volumeNames(config, ctx);
      addMount({ type: "volume", source: configVol, target: targets.configDir });
      addMount({ type: "volume", source: stateVol, target: targets.stateDir });
    }

    next.mounts = mounts;
    return next;
  },
  markerBlocks(raw) {
    const config = raw as unknown as TelegramConfig;
    return [{
      path: "CLAUDE.md",
      startMarker: "<!-- akf plugin: telegram start -->",
      endMarker: "<!-- akf plugin: telegram end -->",
      contents: renderMarker(config),
    }];
  },
  dockerfileBlocks(raw) {
    const config = raw as unknown as TelegramConfig;
    return [{
      path: ".devcontainer/Dockerfile",
      startMarker: "# >>> akf plugin: telegram",
      endMarker: "# <<< akf plugin: telegram",
      contents: renderDockerfile(config),
    }];
  },
  async doctorChecks(resolved, raw) {
    const config = raw as unknown as TelegramConfig;
    const checks: PluginDoctorCheck[] = [];
    checks.push(await dockerfileBlockCheck(resolved));
    if (config.storage === "host") {
      checks.push({
        label: "telegram",
        severity: "warn",
        detail: "storage='host' — session is shared with host, not isolated",
      });
    }
    checks.push(await upstreamCheck(config));
    return checks;
  },
  postApplyMessages(raw) {
    const config = raw as unknown as TelegramConfig;
    const lines: string[] = [
      "After building the image, run inside the sandbox:",
      "  akf up -- telegram setup    # API credentials from my.telegram.org",
      "  akf up -- telegram auth     # interactive Telegram login",
    ];
    if (config.storage === "instance") {
      lines.push(
        "storage='instance' — this clone has its own session; clones in other paths re-auth separately.",
      );
    } else if (config.storage === "named") {
      lines.push("storage='named' — clones of this repo on the same host share one session.");
    } else {
      lines.push("storage='host' — Telegram session is shared with the host.");
    }
    if (config.userIsolation) {
      lines.push("userIsolation=true — `telegram` runs as the dedicated 'telegram' user via sudo.");
    }
    return lines;
  },
};

// --- helpers ---

function mountTargets(config: TelegramConfig): { configDir: string; stateDir: string } {
  const home = config.userIsolation ? `/home/${TELEGRAM_USER}` : `/home/${NODE_USER}`;
  return {
    configDir: `${home}/.config/telegram-cli`,
    stateDir: `${home}/.local/state/telegram-cli`,
  };
}

function volumeNames(
  config: TelegramConfig,
  ctx: PluginContext,
): { configVol: string; stateVol: string } {
  const stem = projectStem(ctx.workspaceDir);
  if (config.storage === "named") {
    return {
      configVol: config.configVolume ?? `tg-${stem}-config`,
      stateVol: config.stateVolume ?? `tg-${stem}-state`,
    };
  }
  // storage === "instance" — bind to absolute path so different clones
  // (different paths on disk) get different volumes. Not written to config.
  const hash = djb2Hex(ctx.workspaceDir);
  return {
    configVol: `tg-${stem}-${hash}-config`,
    stateVol: `tg-${stem}-${hash}-state`,
  };
}

function projectStem(workspaceDir: string): string {
  const base = basename(workspaceDir).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const trimmed = base.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return trimmed || "akf";
}

// Non-crypto stable hash. 8 hex chars is enough to disambiguate a handful
// of clones on one host; collision risk is tiny and the worst case (two
// paths share a volume) is a re-auth, not data loss.
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function renderMarker(config: TelegramConfig): string {
  const storageLine = config.storage === "host"
    ? "Storage: **host** — session shared with the host's `~/.config/telegram-cli`."
    : config.storage === "named"
    ? "Storage: **named** — shared across clones of this repo on the same host."
    : "Storage: **instance** — this clone has its own session; other clones re-auth.";
  const userLine = config.userIsolation
    ? "The CLI runs as the dedicated `telegram` system user via passwordless sudo."
    : `The CLI runs as the agent user (\`${NODE_USER}\`).`;
  return `## Telegram inside the sandbox

This project enables the akf Telegram plugin. The CLI is \`telegram\`.

${storageLine}
${userLine}

One-time bootstrap (inside the sandbox):

\`\`\`bash
telegram setup    # API credentials from my.telegram.org
telegram auth     # interactive Telegram login
\`\`\`

Then \`telegram whoami\` should report \`authenticated: true\`. For per-command
usage and troubleshooting, see the \`telegram\` skill in your Claude config.`;
}

function renderDockerfile(config: TelegramConfig): string {
  const targets = mountTargets(config);
  const lines: string[] = [];

  lines.push(`# Install gskril/telegram-cli pinned to an immutable commit SHA.`);
  lines.push(`# Bump by editing 'sha' in .apfelkaefig.json then \`akf clean && akf up\`.`);
  lines.push(`ARG TELEGRAM_CLI_REPO=${config.repo}`);
  lines.push(`ARG TELEGRAM_CLI_SHA=${config.sha}`);
  lines.push(`RUN npm install -g pnpm@${PNPM_VERSION} && \\`);
  lines.push(`    git clone "\$TELEGRAM_CLI_REPO" /tmp/tg && \\`);
  lines.push(`    cd /tmp/tg && \\`);
  lines.push(`    git checkout "\$TELEGRAM_CLI_SHA" && \\`);
  // --shamefully-hoist gives rolldown a flat node_modules so it can require
  // its native binding (@rolldown/binding-linux-arm64-gnu) via standard
  // Node module lookup. --frozen-lockfile keeps the SHA pin reproducible.
  // npm i -g for the last step because pnpm 10's global install needs
  // PNPM_HOME (pnpm setup) and npm writes to /usr/local/bin which is on PATH.
  lines.push(`    pnpm install --frozen-lockfile --shamefully-hoist && \\`);
  lines.push(`    pnpm pack && \\`);
  lines.push(`    npm install -g ./telegram-*.tgz && \\`);
  lines.push(`    cd / && rm -rf /tmp/tg`);

  if (config.userIsolation) {
    lines.push(``);
    lines.push(`# userIsolation=true: shadow the CLI with a sudo wrapper so the agent`);
    lines.push(`# user (\`${NODE_USER}\`) can invoke telegram but cannot read the session DB.`);
    lines.push(`RUN mv /usr/local/bin/telegram /usr/local/bin/telegram-real && \\`);
    lines.push(
      `    useradd -r -m -d /home/${TELEGRAM_USER} -s /usr/sbin/nologin ${TELEGRAM_USER} && \\`,
    );
    lines.push(`    mkdir -p ${targets.configDir} ${targets.stateDir} && \\`);
    lines.push(`    chown -R ${TELEGRAM_USER}:${TELEGRAM_USER} /home/${TELEGRAM_USER} && \\`);
    lines.push(
      `    chmod 700 /home/${TELEGRAM_USER}/.config /home/${TELEGRAM_USER}/.local/state && \\`,
    );
    lines.push(`    chmod 700 ${targets.configDir} ${targets.stateDir} && \\`);
    lines.push(
      `    printf '#!/bin/sh\\nexec sudo -u ${TELEGRAM_USER} /usr/local/bin/telegram-real "\$@"\\n' \\`,
    );
    lines.push(`      > /usr/local/bin/telegram && \\`);
    lines.push(`    chmod +x /usr/local/bin/telegram && \\`);
    lines.push(
      `    echo "${NODE_USER} ALL=(${TELEGRAM_USER}) NOPASSWD: /usr/local/bin/telegram-real" \\`,
    );
    lines.push(`      > /etc/sudoers.d/akf-telegram && \\`);
    lines.push(`    chmod 0440 /etc/sudoers.d/akf-telegram && \\`);
    lines.push(`    visudo -c -f /etc/sudoers.d/akf-telegram`);
  } else {
    lines.push(``);
    lines.push(`# Pre-create the session dirs as ${NODE_USER} so named volumes mount with`);
    lines.push(
      `# the right ownership (Apple \`container\` inherits dir ownership on first mount).`,
    );
    lines.push(`RUN mkdir -p ${targets.configDir} ${targets.stateDir} && \\`);
    lines.push(
      `    chown -R ${NODE_USER}:${NODE_USER} /home/${NODE_USER}/.config /home/${NODE_USER}/.local && \\`,
    );
    lines.push(`    chmod 700 ${targets.configDir} ${targets.stateDir}`);
  }

  return lines.join("\n");
}

// --- doctor checks ---

async function dockerfileBlockCheck(resolved: PluginDoctorContext): Promise<PluginDoctorCheck> {
  const dockerfile = typeof resolved.config.image === "object"
    ? resolved.config.image?.dockerfile
    : undefined;
  if (!dockerfile) {
    return {
      label: "telegram",
      severity: "fail",
      detail: "plugin enabled but image.dockerfile is not configured",
    };
  }
  const path = dockerfile.startsWith("/") ? dockerfile : `${resolved.workspaceDir}/${dockerfile}`;
  const text = await readTextIfPresent(path);
  if (!text) {
    return { label: "telegram", severity: "fail", detail: `Dockerfile missing (${path})` };
  }
  return {
    label: "telegram",
    severity: text.includes("# >>> akf plugin: telegram") ? "ok" : "fail",
    detail: text.includes("# >>> akf plugin: telegram")
      ? "Dockerfile block present"
      : "Dockerfile block missing",
  };
}

async function upstreamCheck(config: TelegramConfig): Promise<PluginDoctorCheck> {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(config.repo);
  if (!m) {
    return {
      label: "telegram upstream",
      severity: "info",
      detail: `non-github repo '${config.repo}', skipping upstream check`,
    };
  }
  const [, owner, repo] = m;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "akf-doctor",
        Accept: "application/vnd.github+json",
      },
    });
    clearTimeout(timer);
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      return {
        label: "telegram upstream",
        severity: "warn",
        detail: remaining === "0"
          ? `GitHub rate limit exceeded (60/h unauthenticated) on ${url}`
          : `HTTP 403 from ${url}`,
      };
    }
    if (!res.ok) {
      return {
        label: "telegram upstream",
        severity: "warn",
        detail: `HTTP ${res.status} from ${url}`,
      };
    }
    const data = await res.json() as { sha?: unknown };
    const latest = typeof data.sha === "string" ? data.sha : "";
    if (!/^[a-f0-9]{40}$/.test(latest)) {
      return {
        label: "telegram upstream",
        severity: "warn",
        detail: `unexpected response shape from ${url}`,
      };
    }
    if (latest === config.sha) {
      return {
        label: "telegram upstream",
        severity: "ok",
        detail: `pinned ${config.sha.slice(0, 7)} is up to date`,
      };
    }
    return {
      label: "telegram upstream",
      severity: "warn",
      detail: `pinned ${config.sha.slice(0, 7)} differs from upstream ${
        latest.slice(0, 7)
      } — bump 'sha' in .apfelkaefig.json`,
    };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || /timed out|timeout/i.test(e.message)) {
      return {
        label: "telegram upstream",
        severity: "warn",
        detail: `upstream check timed out fetching ${url}`,
      };
    }
    if (e instanceof Deno.errors.PermissionDenied) {
      return {
        label: "telegram upstream",
        severity: "warn",
        detail: `network permission denied: ${e.message}`,
      };
    }
    return {
      label: "telegram upstream",
      severity: "warn",
      detail: `upstream check failed: ${e.message}`,
    };
  }
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
