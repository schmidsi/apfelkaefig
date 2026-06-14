import { assertEquals } from "@std/assert";
import { parseUpArgs } from "./main.ts";

Deno.test("parseUpArgs: --help requests help instead of launching", () => {
  assertEquals(parseUpArgs(["--help"]).kind, "help");
  assertEquals(parseUpArgs(["-h"]).kind, "help");
  assertEquals(parseUpArgs(["claude", "--help"]).kind, "help");
});

Deno.test("parseUpArgs: unknown flag before -- is an error, not silently dropped", () => {
  const parsed = parseUpArgs(["claude", "--resume"]);
  assertEquals(parsed.kind, "error");
  if (parsed.kind === "error") {
    assertEquals(parsed.message.includes("--resume"), true);
    assertEquals(parsed.message.includes("akf up -- <cmd>"), true); // hint to use the -- form
  }
});

Deno.test("parseUpArgs: known flags and positionals pass through", () => {
  const parsed = parseUpArgs(["--rebuild", "--image", "foo:latest", "claude"]);
  assertEquals(parsed, {
    kind: "run",
    positional: ["claude"],
    imageOverride: "foo:latest",
    rebuild: true,
    serve: false,
  });
});

Deno.test("parseUpArgs: flags after -- are forwarded to the command", () => {
  const parsed = parseUpArgs(["--", "claude", "--resume"]);
  assertEquals(parsed, {
    kind: "run",
    positional: ["claude", "--resume"],
    imageOverride: undefined,
    rebuild: false,
    serve: false,
  });
});

Deno.test("parseUpArgs: no args runs with empty positionals", () => {
  const parsed = parseUpArgs([]);
  assertEquals(parsed, {
    kind: "run",
    positional: [],
    imageOverride: undefined,
    rebuild: false,
    serve: false,
  });
});

Deno.test("parseUpArgs: --serve sets serve and is not a positional", () => {
  const parsed = parseUpArgs(["--serve"]);
  assertEquals(parsed, {
    kind: "run",
    positional: [],
    imageOverride: undefined,
    rebuild: false,
    serve: true,
  });
});
