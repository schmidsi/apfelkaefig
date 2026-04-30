// `akf doctor` — preflight checks. Exit code is 0 when everything OK or only
// warnings, 1 when at least one hard-fail check fails.

import { containerVersion, imageExists, realRunner, type Runner } from "../lib/container.ts";
import { ConfigError, findConfig, resolveConfig } from "../lib/config.ts";
import { findOpToken, TruncatedTokenError } from "../lib/secrets.ts";
import { builtInImage } from "../lib/baseimage.ts";

const MIN_CONTAINER_MAJOR = 0;
const MIN_CONTAINER_MINOR = 9;

type Severity = "ok" | "warn" | "fail" | "info";

interface Check {
  label: string;
  severity: Severity;
  detail?: string;
}

export interface DoctorOptions {
  cwd: string;
  run?: Runner;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const run = opts.run ?? realRunner;
  const checks: Check[] = [];

  // Platform.
  if (Deno.build.os !== "darwin" || Deno.build.arch !== "aarch64") {
    checks.push({
      label: "platform",
      severity: "fail",
      detail: `${Deno.build.os}/${Deno.build.arch} (need darwin/arm64)`,
    });
  } else {
    checks.push({ label: "platform", severity: "ok", detail: "darwin/arm64" });
  }

  // Apple `container` version.
  const ver = await containerVersion(run);
  if (!ver) {
    checks.push({
      label: "apple `container`",
      severity: "fail",
      detail: "not found on PATH (https://github.com/apple/container)",
    });
  } else {
    const parsed = parseSemverPrefix(ver);
    const okVer = parsed
      ? parsed.major > MIN_CONTAINER_MAJOR ||
        (parsed.major === MIN_CONTAINER_MAJOR && parsed.minor >= MIN_CONTAINER_MINOR)
      : false;
    checks.push({
      label: "apple `container`",
      severity: okVer ? "ok" : "fail",
      detail: okVer ? ver : `${ver} (need ≥ ${MIN_CONTAINER_MAJOR}.${MIN_CONTAINER_MINOR})`,
    });
  }

  // Resolve config — surface conflicting-config warning explicitly.
  let resolved;
  let configErr: ConfigError | null = null;
  try {
    resolved = await resolveConfig({ cwd: opts.cwd });
  } catch (err) {
    if (err instanceof ConfigError) configErr = err;
    else throw err;
  }
  if (configErr) {
    checks.push({
      label: "config",
      severity: "fail",
      detail: `${configErr.message}${configErr.path ? ` (${configErr.path})` : ""}`,
    });
  } else if (resolved) {
    checks.push({
      label: "config",
      severity: "ok",
      detail: `${resolved.source.kind}${
        "path" in resolved.source ? ` (${resolved.source.path})` : ""
      }`,
    });
    for (const w of resolved.warnings) {
      checks.push({ label: "config", severity: "warn", detail: w });
    }
    // Conflicting-config check — findConfig has the both-present knowledge.
    const found = await findConfig(opts.cwd);
    if (found.apfelkaefig && found.devcontainer) {
      checks.push({
        label: "config",
        severity: "warn",
        detail:
          ".apfelkaefig.json AND .devcontainer/devcontainer.json present; .apfelkaefig.json wins",
      });
    }
  }

  // Resolve built-in image up front so we can decide whether docker is needed.
  const base = await builtInImage();

  // Docker — required when a project Dockerfile is in scope OR when the
  // built-in base image is embedded (MVP: no ghcr.io publishing yet, so the
  // base image is built locally on first `akf up`).
  const projectDockerfile = !!(resolved && typeof resolved.config.image === "object" &&
    resolved.config.image && "dockerfile" in resolved.config.image);
  const builtInNeedsBuild = !!base.embedded && resolved?.config.image === undefined;
  const dockerNeeded = projectDockerfile || builtInNeedsBuild;
  if (dockerNeeded) {
    const dr = await run("docker", ["--version"], { stdout: "null", stderr: "null" });
    const reason = projectDockerfile
      ? "config has image.dockerfile"
      : "built-in base image is built locally (ghcr.io publishing deferred)";
    checks.push({
      label: "docker",
      severity: dr.code === 0 ? "ok" : "fail",
      detail: dr.code === 0 ? `found (${reason})` : `required (${reason}) but not found on PATH`,
    });
  } else {
    checks.push({
      label: "docker",
      severity: "info",
      detail: "not required",
    });
  }

  // 1Password — only required when secrets.onepassword: true.
  const opRequired = resolved?.config.secrets?.onepassword === true;
  try {
    const token = await findOpToken();
    if (opRequired) {
      checks.push({
        label: "1password",
        severity: token ? "ok" : "fail",
        detail: token
          ? "OP_SERVICE_ACCOUNT_TOKEN found"
          : "secrets.onepassword: true but no token in env or macOS keychain",
      });
    } else {
      checks.push({
        label: "1password",
        severity: "info",
        detail: token ? "token present (will be injected)" : "not configured",
      });
    }
  } catch (err) {
    if (err instanceof TruncatedTokenError) {
      checks.push({ label: "1password", severity: "fail", detail: err.message });
    } else {
      throw err;
    }
  }

  // Base image presence — info-only.
  const baseHere = await imageExists(base.ref, run);
  const action = base.embedded ? "build on first use" : "pull on first use";
  checks.push({
    label: "base image",
    severity: "info",
    detail: baseHere ? `${base.ref} cached` : `${base.ref} not cached (will ${action})`,
  });

  // Render.
  for (const c of checks) {
    console.log(`  ${formatSeverity(c.severity)}  ${c.label.padEnd(18)} ${c.detail ?? ""}`);
  }

  const failed = checks.some((c) => c.severity === "fail");
  return failed ? 1 : 0;
}

function parseSemverPrefix(v: string): { major: number; minor: number } | null {
  // Accept "0.9.0", "container 0.9.1", etc — find first MAJOR.MINOR pair.
  const m = v.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

function formatSeverity(s: Severity): string {
  switch (s) {
    case "ok":
      return "[ok]  ";
    case "warn":
      return "[warn]";
    case "fail":
      return "[fail]";
    case "info":
      return "[info]";
  }
}
