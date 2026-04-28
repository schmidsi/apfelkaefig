import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";

export type WriteStatus = "created" | "skipped-exists";
export type AppendStatus = "created" | "appended" | "skipped-present";

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
