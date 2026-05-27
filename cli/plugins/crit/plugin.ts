import { join } from "@std/path";
import type { BuiltInPlugin, PluginDoctorCheck, PluginDoctorContext } from "../types.ts";

const CRIT_GUIDANCE = `## Crit inside the sandbox

This project enables the akf Crit plugin. The sandbox image installs the pinned
\`crit\` binary and publishes the local Crit UI on \`127.0.0.1:3247\`.

After the image is built, run this once from the project root:

\`\`\`bash
akf up -- crit install claude-code
\`\`\`

That command uses Crit's own Claude Code installer as the source of truth for
the project integration files. Once those files exist, use \`/crit\` in Claude
Code to start a review.

The global Claude marketplace plugin is still required if you want Crit's
marketplace-only plan-mode hook.`;

const CRIT_DOCKERFILE = `# Install Crit CLI for review workflows.
RUN ARCH=$(dpkg --print-architecture) && \\
    CRIT_VERSION=v0.13.0 && \\
    case "$ARCH" in \\
      amd64) CRIT_ARCH=amd64; CRIT_SHA256=cfc70d88ab3748f9b936141bc52335b02503494da70f65076a1346715cfb1723 ;; \\
      arm64) CRIT_ARCH=arm64; CRIT_SHA256=fa86152d51b92361b0fa9824de999b6248c5827f88f33d0554bcc1b5fc753ecf ;; \\
      *) echo "unsupported arch $ARCH" && exit 1 ;; \\
    esac && \\
    curl -fsSL -o /usr/local/bin/crit "https://github.com/tomasz-tomczyk/crit/releases/download/$CRIT_VERSION/crit-linux-$CRIT_ARCH" && \\
    echo "$CRIT_SHA256  /usr/local/bin/crit" | sha256sum -c - && \\
    chmod +x /usr/local/bin/crit && \\
    crit --version`;

export const critPlugin: BuiltInPlugin = {
  id: "crit",
  aliases: [],
  description: "Install Crit and publish its local review UI on 127.0.0.1:3247.",
  defaultConfig: {
    enabled: true,
    agentIntegration: "claude-code",
    installMethod: "pinned-release",
    version: "v0.13.0",
    port: 3247,
  },
  applyConfig(base, config, _ctx) {
    if (!config.enabled) return base;
    const port = typeof config.port === "number" ? config.port : 3247;
    const ports = [...(base.ports ?? [])];
    if (
      !ports.some((p) =>
        p.hostIp === "127.0.0.1" && p.host === port && p.container === port &&
        (p.protocol ?? "tcp") === "tcp"
      )
    ) {
      ports.push({ hostIp: "127.0.0.1", host: port, container: port, protocol: "tcp" });
    }
    return {
      ...base,
      env: {
        ...(base.env ?? {}),
        CRIT_HOST: "0.0.0.0",
        CRIT_PORT: String(port),
      },
      image: { dockerfile: ".devcontainer/Dockerfile" },
      ports,
    };
  },
  markerBlocks(_config) {
    return [{
      path: "CLAUDE.md",
      startMarker: "<!-- akf plugin: crit start -->",
      endMarker: "<!-- akf plugin: crit end -->",
      contents: CRIT_GUIDANCE,
    }];
  },
  dockerfileBlocks(_config) {
    return [{
      path: ".devcontainer/Dockerfile",
      startMarker: "# >>> akf plugin: crit",
      endMarker: "# <<< akf plugin: crit",
      contents: CRIT_DOCKERFILE,
    }];
  },
  async doctorChecks(resolved, _config) {
    return await critDoctorChecks(resolved);
  },
  postApplyMessages(_config) {
    return [
      "After building the image, run: akf up -- crit install claude-code",
      "Crit UI will be published at http://127.0.0.1:3247 when Crit is running.",
    ];
  },
};

async function critDoctorChecks(resolved: PluginDoctorContext): Promise<PluginDoctorCheck[]> {
  const checks: PluginDoctorCheck[] = [];
  const dockerfile = typeof resolved.config.image === "object"
    ? resolved.config.image?.dockerfile
    : undefined;
  const dockerfilePath = dockerfile
    ? dockerfile.startsWith("/") ? dockerfile : join(resolved.workspaceDir, dockerfile)
    : undefined;
  if (!dockerfilePath) {
    checks.push({
      label: "crit",
      severity: "fail",
      detail: "plugin enabled but image.dockerfile is not configured",
    });
  } else {
    const dockerfileText = await readTextIfPresent(dockerfilePath);
    checks.push({
      label: "crit",
      severity: dockerfileText?.includes("# >>> akf plugin: crit") ? "ok" : "fail",
      detail: dockerfileText
        ? "Dockerfile block present"
        : `Dockerfile missing (${dockerfilePath})`,
    });
  }

  const hasClaudeProjectFiles = await pathExists(join(resolved.workspaceDir, ".claude-plugin")) &&
    await pathExists(join(resolved.workspaceDir, "hooks")) &&
    await pathExists(join(resolved.workspaceDir, "skills"));
  checks.push({
    label: "crit",
    severity: hasClaudeProjectFiles ? "ok" : "warn",
    detail: hasClaudeProjectFiles
      ? "Claude project integration files present"
      : "run `akf up -- crit install claude-code` from the project root",
  });
  return checks;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
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
