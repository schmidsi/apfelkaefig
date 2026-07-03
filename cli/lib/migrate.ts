// Config auto-migration (tasks/011, decision 10). Configs written before
// resolve-time plugin transforms carry materialized leftovers: mounts, ports,
// env, and secrets entries that `akf plugin add` used to write and that the
// transforms now derive on every run. Runtime dedupe keeps them harmless, but
// they are dead weight and a second source of truth — strip them.
//
// Strategy: compute what the enabled plugins derive on a clean slate, then
// remove any config entry that deep-equals a derived one. Only pure-JSON
// configs are rewritten (a JSONC file with comments would lose them); for
// JSONC the caller gets the removable list to print as advice instead.

import { applyPluginTransforms } from "./plugins.ts";
import type { ApfelkaefigConfig, MountConfig, PortConfig } from "./schema.ts";

export interface MigrationResult {
  // Human-readable labels of the removed (or removable) entries.
  removed: string[];
  // True when the file was rewritten (backup written alongside); false when
  // the file is JSONC and the entries were only reported.
  rewritten: boolean;
  backupPath?: string;
}

// Inspect (and, for pure-JSON files, rewrite) the config at configPath.
// Returns null when there is nothing to migrate.
export async function migrateMaterializedConfig(
  { configPath, workspaceDir }: { configPath: string; workspaceDir: string },
): Promise<MigrationResult | null> {
  const text = await Deno.readTextFile(configPath);
  let raw: ApfelkaefigConfig;
  let pureJson = true;
  try {
    raw = JSON.parse(text) as ApfelkaefigConfig;
  } catch {
    // JSONC (comments / trailing commas): report-only, never rewrite — a
    // JSON.stringify round-trip would destroy the comments.
    pureJson = false;
    const { parse } = await import("@std/jsonc");
    raw = parse(text) as unknown as ApfelkaefigConfig;
  }
  if (!raw?.plugins || Object.keys(raw.plugins).length === 0) return null;

  // What the enabled plugins derive when nothing is materialized.
  const ctx = { workspaceDir };
  const derived = applyPluginTransforms(
    { ...raw, mounts: undefined, ports: undefined, env: undefined, secrets: undefined },
    ctx,
  );

  const removed: string[] = [];
  const next: ApfelkaefigConfig = { ...raw };

  if (raw.mounts) {
    const derivedMounts = new Set((derived.mounts ?? []).map(mountKey));
    const kept = raw.mounts.filter((m) => {
      if (!derivedMounts.has(mountKey(m))) return true;
      removed.push(`mounts[target=${m.target}]`);
      return false;
    });
    if (kept.length === 0) delete next.mounts;
    else next.mounts = kept;
  }

  if (raw.ports) {
    const derivedPorts = new Set((derived.ports ?? []).map(portKey));
    const kept = raw.ports.filter((p) => {
      if (!derivedPorts.has(portKey(p))) return true;
      removed.push(`ports[${p.host}]`);
      return false;
    });
    if (kept.length === 0) delete next.ports;
    else next.ports = kept;
  }

  if (raw.env) {
    const env = { ...raw.env };
    for (const [k, v] of Object.entries(derived.env ?? {})) {
      if (env[k] === v) {
        removed.push(`env.${k}`);
        delete env[k];
      }
    }
    if (Object.keys(env).length === 0) delete next.env;
    else next.env = env;
  }

  // secrets.onepassword: true is derived by the 1password plugin; an explicit
  // `false` is a user opt-out and never matches the derived value.
  if (
    raw.secrets?.onepassword !== undefined &&
    raw.secrets.onepassword === derived.secrets?.onepassword
  ) {
    removed.push("secrets.onepassword");
    const secrets = { ...raw.secrets };
    delete secrets.onepassword;
    if (Object.keys(secrets).length === 0) delete next.secrets;
    else next.secrets = secrets;
  }

  if (removed.length === 0) return null;
  if (!pureJson) return { removed, rewritten: false };

  const backupPath = `${configPath}.bak`;
  await Deno.writeTextFile(backupPath, text);
  await Deno.writeTextFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { removed, rewritten: true, backupPath };
}

function mountKey(m: MountConfig): string {
  return JSON.stringify([m.type ?? "bind", m.source, m.target, m.readonly ?? false]);
}

function portKey(p: PortConfig): string {
  return JSON.stringify([p.hostIp ?? "", p.host, p.container, p.protocol ?? "tcp"]);
}
