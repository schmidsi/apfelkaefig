import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  ALLOWED_TOP_LEVEL_KEYS,
  type ApfelkaefigConfig,
  DEFAULTS,
  type ImageConfig,
  type MountConfig,
  SCHEMA_VERSION,
  VOLUME_NAME_RE,
} from "./schema.ts";
import { listPlugins, PluginError, resolvePluginId } from "./plugins.ts";
import { pathExists, projectSlug } from "./fs.ts";

export type ConfigSource =
  | { kind: "apfelkaefig"; path: string; dir: string; raw: ApfelkaefigConfig }
  | { kind: "devcontainer"; path: string; dir: string; raw: Record<string, unknown> }
  | { kind: "defaults"; dir: string };

export interface ResolvedConfig {
  source: ConfigSource;
  workspaceDir: string;
  config: ApfelkaefigConfig;
  warnings: string[];
}

export interface CliOverrides {
  command?: string[];
  image?: string;
}

const APFELKAEFIG_FILE = ".apfelkaefig.json";
const DEVCONTAINER_FILE = join(".devcontainer", "devcontainer.json");
const GIT_DIR = ".git";

// Walk up from cwd looking for an apfelkaefig or devcontainer config.
// Stop at filesystem root or when we cross a .git boundary that has neither.
export async function findConfig(
  cwd: string,
): Promise<{ apfelkaefig?: string; devcontainer?: string; dir: string }> {
  let dir = resolve(cwd);
  while (true) {
    const apf = join(dir, APFELKAEFIG_FILE);
    const dev = join(dir, DEVCONTAINER_FILE);
    const [apfExists, devExists, gitExists] = await Promise.all([
      pathExists(apf),
      pathExists(dev),
      pathExists(join(dir, GIT_DIR)),
    ]);
    if (apfExists || devExists) {
      return {
        apfelkaefig: apfExists ? apf : undefined,
        devcontainer: devExists ? dev : undefined,
        dir,
      };
    }
    if (gitExists) return { dir };
    const parent = dirname(dir);
    if (parent === dir) return { dir: resolve(cwd) };
    dir = parent;
  }
}

export class ConfigError extends Error {
  constructor(message: string, public path?: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(text: string, sourcePath?: string): ApfelkaefigConfig {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    throw new ConfigError(
      `failed to parse JSONC: ${(err as Error).message}`,
      sourcePath,
    );
  }
  return validate(parsed, sourcePath);
}

export function validate(value: unknown, sourcePath?: string): ApfelkaefigConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("config must be a JSON object", sourcePath);
  }
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(
        `unknown top-level key '${key}'. Allowed: ${[...ALLOWED_TOP_LEVEL_KEYS].sort().join(", ")}`,
        sourcePath,
      );
    }
  }

  if (!("version" in obj)) {
    throw new ConfigError("missing required field 'version'", sourcePath);
  }
  if (obj.version !== SCHEMA_VERSION) {
    throw new ConfigError(
      `unsupported version ${JSON.stringify(obj.version)}; expected ${SCHEMA_VERSION}`,
      sourcePath,
    );
  }

  if ("image" in obj && obj.image !== undefined) validateImage(obj.image, sourcePath);
  if ("mounts" in obj && obj.mounts !== undefined) validateMounts(obj.mounts, sourcePath);
  if ("env" in obj && obj.env !== undefined) validateEnv(obj.env, sourcePath);
  if ("user" in obj && obj.user !== undefined && typeof obj.user !== "string") {
    throw new ConfigError("'user' must be a string", sourcePath);
  }
  if (
    "workspaceFolder" in obj && obj.workspaceFolder !== undefined &&
    typeof obj.workspaceFolder !== "string"
  ) {
    throw new ConfigError("'workspaceFolder' must be a string", sourcePath);
  }
  if ("resources" in obj && obj.resources !== undefined) {
    validateResources(obj.resources, sourcePath);
  }
  if ("command" in obj && obj.command !== undefined) validateCommand(obj.command, sourcePath);
  if ("tmux" in obj && obj.tmux !== undefined && typeof obj.tmux !== "boolean") {
    throw new ConfigError("'tmux' must be a boolean", sourcePath);
  }
  if ("secrets" in obj && obj.secrets !== undefined) validateSecrets(obj.secrets, sourcePath);
  if ("ports" in obj && obj.ports !== undefined) validatePorts(obj.ports, sourcePath);
  if ("plugins" in obj && obj.plugins !== undefined) validatePlugins(obj.plugins, sourcePath);
  if (
    "claudeConfigDir" in obj && obj.claudeConfigDir !== undefined &&
    typeof obj.claudeConfigDir !== "string"
  ) {
    throw new ConfigError("'claudeConfigDir' must be a string", sourcePath);
  }

  return obj as unknown as ApfelkaefigConfig;
}

function validateImage(v: unknown, sourcePath?: string): void {
  if (typeof v === "string") return;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "dockerfile") {
      const df = (v as Record<string, unknown>).dockerfile;
      if (typeof df === "string") return;
    }
  }
  throw new ConfigError(
    "'image' must be a string or { dockerfile: string }",
    sourcePath,
  );
}

function validateMounts(v: unknown, sourcePath?: string): void {
  if (!Array.isArray(v)) throw new ConfigError("'mounts' must be an array", sourcePath);
  for (const [i, m] of v.entries()) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ConfigError(`'mounts[${i}]' must be an object`, sourcePath);
    }
    const mr = m as Record<string, unknown>;
    if (typeof mr.source !== "string" || typeof mr.target !== "string") {
      throw new ConfigError(
        `'mounts[${i}]' requires string 'source' and 'target'`,
        sourcePath,
      );
    }
    for (const k of Object.keys(mr)) {
      if (!["type", "source", "target", "readonly"].includes(k)) {
        throw new ConfigError(`'mounts[${i}]' has unknown key '${k}'`, sourcePath);
      }
    }
    if ("readonly" in mr && typeof mr.readonly !== "boolean") {
      throw new ConfigError(`'mounts[${i}].readonly' must be a boolean`, sourcePath);
    }
    if ("type" in mr) {
      if (mr.type !== "bind" && mr.type !== "volume") {
        throw new ConfigError(
          `'mounts[${i}].type' must be 'bind' or 'volume'`,
          sourcePath,
        );
      }
    }
    if (mr.type === "volume") {
      if (mr.source.includes("${")) {
        throw new ConfigError(
          `'mounts[${i}].source' is a volume name and cannot contain \${...} substitutions`,
          sourcePath,
        );
      }
      if (!VOLUME_NAME_RE.test(mr.source)) {
        throw new ConfigError(
          `'mounts[${i}].source' is not a valid volume name (must match ${VOLUME_NAME_RE})`,
          sourcePath,
        );
      }
    }
  }
}

function validateEnv(v: unknown, sourcePath?: string): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError("'env' must be an object", sourcePath);
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new ConfigError(`'env.${k}' must be a string`, sourcePath);
    }
  }
}

function validateResources(v: unknown, sourcePath?: string): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError("'resources' must be an object", sourcePath);
  }
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["cpus", "memory"].includes(k)) {
      throw new ConfigError(`'resources' has unknown key '${k}'`, sourcePath);
    }
  }
  if ("cpus" in r && (typeof r.cpus !== "number" || !Number.isInteger(r.cpus) || r.cpus < 1)) {
    throw new ConfigError("'resources.cpus' must be a positive integer", sourcePath);
  }
  if ("memory" in r) {
    if (typeof r.memory !== "string" || !/^\d+[KMG]?$/.test(r.memory)) {
      throw new ConfigError(
        "'resources.memory' must match /^\\d+[KMG]?$/ (e.g. \"4G\")",
        sourcePath,
      );
    }
  }
}

function validateCommand(v: unknown, sourcePath?: string): void {
  if (typeof v === "string") return;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return;
  throw new ConfigError("'command' must be a string or array of strings", sourcePath);
}

function validateSecrets(v: unknown, sourcePath?: string): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError("'secrets' must be an object", sourcePath);
  }
  const s = v as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (k !== "onepassword") {
      throw new ConfigError(`'secrets' has unknown key '${k}'`, sourcePath);
    }
  }
  if ("onepassword" in s && typeof s.onepassword !== "boolean") {
    throw new ConfigError("'secrets.onepassword' must be a boolean", sourcePath);
  }
}

function validatePorts(v: unknown, sourcePath?: string): void {
  if (!Array.isArray(v)) throw new ConfigError("'ports' must be an array", sourcePath);
  for (const [i, p] of v.entries()) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new ConfigError(`'ports[${i}]' must be an object`, sourcePath);
    }
    const pr = p as Record<string, unknown>;
    for (const k of Object.keys(pr)) {
      if (!["hostIp", "host", "container", "protocol"].includes(k)) {
        throw new ConfigError(`'ports[${i}]' has unknown key '${k}'`, sourcePath);
      }
    }
    if ("hostIp" in pr && typeof pr.hostIp !== "string") {
      throw new ConfigError(`'ports[${i}].hostIp' must be a string`, sourcePath);
    }
    if (!isPort(pr.host)) {
      throw new ConfigError(`'ports[${i}].host' must be an integer from 1 to 65535`, sourcePath);
    }
    if (!isPort(pr.container)) {
      throw new ConfigError(
        `'ports[${i}].container' must be an integer from 1 to 65535`,
        sourcePath,
      );
    }
    if (
      "protocol" in pr && pr.protocol !== undefined && pr.protocol !== "tcp" &&
      pr.protocol !== "udp"
    ) {
      throw new ConfigError(`'ports[${i}].protocol' must be 'tcp' or 'udp'`, sourcePath);
    }
  }
}

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function validatePlugins(v: unknown, sourcePath?: string): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError("'plugins' must be an object", sourcePath);
  }
  for (const [id, rawConfig] of Object.entries(v as Record<string, unknown>)) {
    let canonical: string;
    try {
      canonical = resolvePluginId(id);
    } catch (err) {
      if (err instanceof PluginError) {
        throw new ConfigError(err.message, sourcePath);
      }
      throw err;
    }
    if (canonical !== id) {
      throw new ConfigError(
        `'plugins.${id}' must use canonical plugin id '${canonical}'`,
        sourcePath,
      );
    }
    validatePluginConfig(id, rawConfig, sourcePath);
  }
}

function validatePluginConfig(id: string, v: unknown, sourcePath?: string): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`'plugins.${id}' must be an object`, sourcePath);
  }
  const plugin = listPlugins().find((p) => p.id === id);
  if (!plugin) {
    throw new ConfigError(`unknown plugin '${id}'`, sourcePath);
  }
  try {
    plugin.validateConfig?.(v as Record<string, unknown>);
  } catch (err) {
    throw new ConfigError((err as Error).message, sourcePath);
  }
}

// Resolve the active config according to the chain documented in tasks/004_refactor.md:
//   1. .apfelkaefig.json if present (walk up).
//   2. else .devcontainer/devcontainer.json if present (same walk).
//   3. else built-in defaults.
//   4. CLI flags override whichever resolved.
// If both exist, .apfelkaefig.json wins; emits a warning.
export async function resolveConfig({
  cwd,
  cliOverrides = {},
}: {
  cwd: string;
  cliOverrides?: CliOverrides;
}): Promise<ResolvedConfig> {
  const found = await findConfig(cwd);
  const warnings: string[] = [];
  let source: ConfigSource;
  let config: ApfelkaefigConfig;

  if (found.apfelkaefig) {
    if (found.devcontainer) {
      warnings.push(
        `both .apfelkaefig.json and ${DEVCONTAINER_FILE} present in ${found.dir}; .apfelkaefig.json wins`,
      );
    }
    const text = await Deno.readTextFile(found.apfelkaefig);
    config = parseConfig(text, found.apfelkaefig);
    source = { kind: "apfelkaefig", path: found.apfelkaefig, dir: found.dir, raw: config };
  } else if (found.devcontainer) {
    const text = await Deno.readTextFile(found.devcontainer);
    let raw: unknown;
    try {
      raw = parseJsonc(text);
    } catch (err) {
      throw new ConfigError(
        `failed to parse devcontainer.json: ${(err as Error).message}`,
        found.devcontainer,
      );
    }
    if (typeof raw !== "object" || raw === null) {
      throw new ConfigError("devcontainer.json must be a JSON object", found.devcontainer);
    }
    config = devcontainerToConfig(raw as Record<string, unknown>);
    // Per devcontainer spec, build.dockerfile is relative to devcontainer.json's
    // directory (typically .devcontainer/), not the workspace root. Normalize to
    // absolute here so downstream callers can stay path-agnostic.
    if (
      typeof config.image === "object" && config.image !== null &&
      "dockerfile" in config.image && typeof config.image.dockerfile === "string" &&
      !isAbsolute(config.image.dockerfile)
    ) {
      config = {
        ...config,
        image: {
          dockerfile: resolve(dirname(found.devcontainer), config.image.dockerfile),
        },
      };
    }
    source = {
      kind: "devcontainer",
      path: found.devcontainer,
      dir: found.dir,
      raw: raw as Record<string, unknown>,
    };
  } else {
    config = { version: SCHEMA_VERSION };
    source = { kind: "defaults", dir: found.dir };
  }

  if (cliOverrides.command) config = { ...config, command: cliOverrides.command };
  if (cliOverrides.image) config = { ...config, image: cliOverrides.image };

  return { source, workspaceDir: source.dir, config, warnings };
}

// Best-effort translation from a devcontainer.json subset to an ApfelkaefigConfig.
// Covers: build.dockerfile / image, remoteUser, workspaceFolder, mounts, containerEnv, remoteEnv.
// Anything else is ignored.
function devcontainerToConfig(dc: Record<string, unknown>): ApfelkaefigConfig {
  const out: ApfelkaefigConfig = { version: SCHEMA_VERSION };

  if (typeof dc.image === "string") {
    out.image = dc.image as ImageConfig;
  } else if (
    typeof dc.build === "object" && dc.build !== null &&
    typeof (dc.build as Record<string, unknown>).dockerfile === "string"
  ) {
    out.image = { dockerfile: (dc.build as Record<string, unknown>).dockerfile as string };
  }

  if (typeof dc.remoteUser === "string") out.user = dc.remoteUser;
  if (typeof dc.workspaceFolder === "string") out.workspaceFolder = dc.workspaceFolder;

  if (Array.isArray(dc.mounts)) {
    const mounts: MountConfig[] = [];
    for (const m of dc.mounts) {
      if (typeof m !== "string") continue;
      const parsed = parseDevcontainerMount(m);
      if (parsed) mounts.push(parsed);
    }
    if (mounts.length > 0) out.mounts = mounts;
  }

  const env: Record<string, string> = {};
  for (const key of ["containerEnv", "remoteEnv"]) {
    const v = dc[key];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") env[k] = val;
      }
    }
  }
  if (Object.keys(env).length > 0) out.env = env;

  return out;
}

// Parse a devcontainer-style mount string: "source=...,target=...,type=bind,readonly".
// Preserves type=volume so round-trips through eject --devcontainer don't lose it.
function parseDevcontainerMount(s: string): MountConfig | null {
  const parts: Record<string, string> = {};
  let readonly = false;
  for (const piece of s.split(",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) {
      if (piece.trim() === "readonly" || piece.trim() === "ro") readonly = true;
      continue;
    }
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (k === "readonly" || k === "ro") {
      readonly = v !== "false";
    } else {
      parts[k] = v;
    }
  }
  if (!parts.source || !parts.target) return null;
  const m: MountConfig = { source: parts.source, target: parts.target };
  if (parts.type === "volume") m.type = "volume";
  if (readonly) m.readonly = true;
  return m;
}

// Substitute ${localEnv:VAR}, ${localWorkspaceFolder}, ${localWorkspaceFolderBasename},
// ${devcontainerId}. Same dialect as devcontainer.json. ${devcontainerId} is the
// spec's stable per-project id (commonly used in named-volume sources); we resolve
// it to the project slug so it matches the volume-name regex and stays consistent
// with akf's image tag (`<slug>-sandbox`).
export function substitute(
  s: string,
  ctx: { workspaceFolder: string; env?: Record<string, string | undefined> },
): string {
  const env = ctx.env ?? Deno.env.toObject();
  const basename = ctx.workspaceFolder.split("/").filter(Boolean).pop() ?? "";

  let out = s;
  out = out.replace(
    /\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => env[name] ?? "",
  );
  out = out.replaceAll("${localWorkspaceFolder}", ctx.workspaceFolder);
  out = out.replaceAll("${localWorkspaceFolderBasename}", basename);
  out = out.replaceAll("${devcontainerId}", projectSlug(ctx.workspaceFolder));
  return out;
}

// Compute the effective values used by `up` after applying defaults.
export function effective(resolved: ResolvedConfig): {
  user: string;
  workspaceFolder: string;
  command: string[];
  resources: { cpus: number; memory: string };
  claudeConfigDir?: string;
  tmux: boolean;
} {
  const c = resolved.config;
  const cmd = c.command === undefined
    ? [...DEFAULTS.command]
    : Array.isArray(c.command)
    ? c.command
    : c.command.split(/\s+/).filter(Boolean);
  return {
    user: c.user ?? DEFAULTS.user,
    workspaceFolder: c.workspaceFolder ?? DEFAULTS.workspaceFolder,
    command: cmd,
    resources: {
      cpus: c.resources?.cpus ?? DEFAULTS.resources.cpus,
      memory: c.resources?.memory ?? DEFAULTS.resources.memory,
    },
    claudeConfigDir: c.claudeConfigDir,
    tmux: c.tmux ?? DEFAULTS.tmux,
  };
}
