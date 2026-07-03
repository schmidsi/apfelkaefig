// Writes cli/build_info.json with the current git commit + build date so the
// compiled binary's `--version` reflects exactly which source it was built from.
// Run by `deno task compile` before `deno compile`. The file is gitignored and
// regenerated on every build; `deno task dev` runs without it and falls back to
// "dev" (see cli/main.ts).

async function git(args: string[]): Promise<string> {
  try {
    const r = await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output();
    return new TextDecoder().decode(r.stdout).trim();
  } catch {
    return "";
  }
}

const commit = (await git(["rev-parse", "--short", "HEAD"])) || "unknown";
const dirty = (await git(["status", "--porcelain"])) ? "-dirty" : "";
const date = new Date().toISOString().slice(0, 10);
const stamp = `${commit}${dirty} ${date}`;

const out = new URL("../cli/build_info.json", import.meta.url);
await Deno.writeTextFile(out, JSON.stringify({ stamp }) + "\n");
console.log(`stamped build: ${stamp}`);
