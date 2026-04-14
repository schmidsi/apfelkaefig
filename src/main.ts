import { parseArgs } from "@std/cli/parse-args";
import { runInit } from "./commands/init.ts";

const USAGE = `akf — dev sandboxes on Apple container

Usage:
  akf init            Augment the current folder with Apple-container sandbox scaffolding.
  akf --help          Show this help.
  akf --version       Show version.
`;

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv, {
    boolean: ["help", "version"],
    alias: { h: "help", v: "version" },
    stopEarly: true,
  });

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }

  const [subcommand] = flags._;

  if (!subcommand) {
    console.log(USAGE);
    return 0;
  }

  if (subcommand === "init") {
    await runInit({ cwd: Deno.cwd() });
    return 0;
  }

  console.error(`akf: unknown command '${subcommand}'`);
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
