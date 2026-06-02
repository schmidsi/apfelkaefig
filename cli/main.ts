import { parseArgs } from "@std/cli/parse-args";
import { runInit } from "./commands/init.ts";
import { runUp } from "./commands/up.ts";
import { runBuild } from "./commands/build.ts";
import { runEject } from "./commands/eject.ts";
import { runClean } from "./commands/clean.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runPluginCommand } from "./commands/plugin.ts";
import { runStatusline } from "./commands/statusline.ts";
import { parsePluginList, PluginError } from "./lib/plugins.ts";
import denoJson from "../deno.json" with { type: "json" };

const USAGE = `akf — dev sandboxes on Apple container (der Käfer im Apfel)

Usage:
  akf up [--rebuild] [-- cmd args…]
                           Launch the sandbox (built-in image if no config).
                           --rebuild forces an image rebuild/refresh.
  akf init [--advanced|--bash] [--plugins <ids>]
                           Set up the current folder for akf.
  akf plugin list|explain|add
                           Manage built-in sandbox plugins.
  akf statusline           Install the Claude Code statusline helper into
                           ~/.claude/bin/ (one-time, global).
  akf build [--from-dockerfile <path>] [--no-cleanup]
                           Build a custom image (Docker → local registry → Apple container).
  akf eject --devcontainer | --bash [--force]
                           Write self-contained artifacts. One-way.
  akf clean [--images] [--all]
                           Stop + remove sandbox container; optional cleanup.
  akf doctor               Run preflight checks.
  akf --help               Show this help.
  akf --version            Show version.
`;

const VERSION = denoJson.version;

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "up") {
    return await dispatchUp(argv.slice(1));
  }

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

  const [subcommand, ...rest] = flags._.map(String);

  if (!subcommand) {
    console.error(
      "No subcommand given — running `akf up`. Run `akf --help` to see other commands.",
    );
    return await dispatchUp([]);
  }

  switch (subcommand) {
    case "up":
      return await dispatchUp(rest);
    case "init":
      return await dispatchInit(rest);
    case "build":
      return await dispatchBuild(rest);
    case "eject":
      return await dispatchEject(rest);
    case "clean":
      return await dispatchClean(rest);
    case "doctor":
      return await runDoctor({ cwd: Deno.cwd() });
    case "plugin":
      return await runPluginCommand({ cwd: Deno.cwd(), args: rest });
    case "statusline":
      return await runStatusline();
    default:
      console.error(`akf: unknown command '${subcommand}'`);
      console.error(USAGE);
      return 2;
  }
}

async function dispatchUp(rest: string[]): Promise<number> {
  const flags = parseArgs(rest, {
    string: ["image"],
    boolean: ["rebuild"],
    "--": true,
  });
  const positional = [
    ...flags._.map(String),
    ...(flags["--"] ?? []).map(String),
  ];
  return await runUp({
    cwd: Deno.cwd(),
    positional,
    imageOverride: flags.image,
    rebuild: flags.rebuild,
  });
}

async function dispatchInit(rest: string[]): Promise<number> {
  const flags = parseArgs(rest, { boolean: ["advanced", "bash"], string: ["plugins"] });
  const mode = flags.advanced ? "advanced" : flags.bash ? "bash" : "default";
  const plugins = flags.plugins ? parsePluginList(flags.plugins) : [];
  await runInit({ cwd: Deno.cwd(), mode, plugins });
  return 0;
}

async function dispatchBuild(rest: string[]): Promise<number> {
  const flags = parseArgs(rest, {
    string: ["from-dockerfile", "tag"],
    boolean: ["no-cleanup"],
  });
  return await runBuild({
    cwd: Deno.cwd(),
    fromDockerfile: flags["from-dockerfile"],
    tag: flags.tag,
    noCleanup: flags["no-cleanup"],
  });
}

async function dispatchEject(rest: string[]): Promise<number> {
  const flags = parseArgs(rest, { boolean: ["devcontainer", "bash", "force"] });
  if (flags.devcontainer && flags.bash) {
    console.error("akf eject: pass exactly one of --devcontainer | --bash");
    return 2;
  }
  if (!flags.devcontainer && !flags.bash) {
    console.error("akf eject: target required: --devcontainer | --bash");
    return 2;
  }
  const target = flags.devcontainer ? "devcontainer" : "bash";
  return await runEject({ cwd: Deno.cwd(), target, force: flags.force });
}

async function dispatchClean(rest: string[]): Promise<number> {
  const flags = parseArgs(rest, { boolean: ["images", "all"] });
  return await runClean({
    cwd: Deno.cwd(),
    removeImages: flags.images,
    removeAll: flags.all,
  });
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (err) {
    if (err instanceof PluginError) {
      console.error(`akf: ${err.message}`);
      Deno.exit(2);
    }
    throw err;
  }
}
