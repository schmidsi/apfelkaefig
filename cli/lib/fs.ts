import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";

export type WriteStatus = "created" | "skipped-exists";
export type AppendStatus = "created" | "appended" | "skipped-present";
export type UpsertStatus = "created" | "appended" | "updated" | "skipped-present";

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
