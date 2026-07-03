import { basename, dirname } from "@std/path";
import { ensureDir } from "@std/fs";

export type WriteStatus = "created" | "skipped-exists";
export type AppendStatus = "created" | "appended" | "skipped-present";
export type UpsertStatus = "created" | "appended" | "updated" | "skipped-present";

export const STATUS_LABELS: Record<WriteStatus | AppendStatus | UpsertStatus, string> = {
  "created": "created",
  "skipped-exists": "skipped (exists)",
  "appended": "appended",
  "skipped-present": "skipped (already present)",
  "updated": "updated",
};

export async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

// Treat any stat failure as "missing" — callers use this to skip optional
// mounts, where erring toward skipping beats crashing.
export function pathExistsSync(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Workspace basename → slug usable in Docker tags and volume names.
// Lowercased + non-alnum stripped; Docker tags must start with [a-z0-9],
// so strip leading separators too.
export function projectSlug(workspaceHostPath: string): string {
  const base = basename(workspaceHostPath).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const trimmed = base.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return trimmed || "akf";
}

// Non-crypto stable hash of a string, 8 hex chars. Disambiguates derived names
// (volumes, container names) across same-basename projects; the worst case of
// a collision is two paths sharing a resource, not data loss.
export function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export async function writeIfMissing(
  path: string,
  contents: string,
  opts: { mode?: number } = {},
): Promise<WriteStatus> {
  try {
    await Deno.lstat(path);
    return "skipped-exists";
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, contents);
  if (opts.mode !== undefined) {
    await Deno.chmod(path, opts.mode);
  }
  return "created";
}

export async function appendBlockIfAbsent(
  path: string,
  startMarker: string,
  endMarker: string,
  block: string,
): Promise<AppendStatus> {
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const rendered = `${startMarker}\n${block.trimEnd()}\n${endMarker}\n`;

  if (existing === null) {
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, rendered);
    return "created";
  }

  if (existing.includes(startMarker)) {
    return "skipped-present";
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const prefix = existing.length === 0 ? "" : `${existing}${separator}\n`;
  await Deno.writeTextFile(path, `${prefix}${rendered}`);
  return "appended";
}

export async function upsertBlock(
  path: string,
  startMarker: string,
  endMarker: string,
  block: string,
  opts: { overwrite?: boolean } = {},
): Promise<UpsertStatus> {
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const rendered = `${startMarker}\n${block.trimEnd()}\n${endMarker}\n`;

  if (existing === null) {
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, rendered);
    return "created";
  }

  const start = existing.indexOf(startMarker);
  if (start < 0) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const prefix = existing.length === 0 ? "" : `${existing}${separator}\n`;
    await Deno.writeTextFile(path, `${prefix}${rendered}`);
    return "appended";
  }

  const end = existing.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`found start marker without end marker in ${path}`);
  }
  const afterEnd = end + endMarker.length;
  const trailingNewline = existing.slice(afterEnd).startsWith("\n") ? 1 : 0;
  const before = existing.slice(0, start);
  const after = existing.slice(afterEnd + trailingNewline);
  const current = existing.slice(start, afterEnd + trailingNewline);
  if (!opts.overwrite && current !== rendered) {
    throw new Error(`owned block in ${path} differs from generated content`);
  }
  const next = `${before}${rendered}${after}`;
  if (next === existing) return "skipped-present";
  await Deno.writeTextFile(path, next);
  return "updated";
}
