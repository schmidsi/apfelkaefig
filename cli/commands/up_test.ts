import { assertEquals } from "@std/assert";
import { redactDebugArgs } from "./up.ts";

Deno.test("redactDebugArgs: masks secret env values, keeps everything else", () => {
  const args = [
    "run",
    "--rm",
    "-v",
    "/host:/home/node/.claude",
    "-e",
    "CLAUDE_CONFIG_DIR=/home/node/.claude",
    "-e",
    "AKF_SANDBOX=1",
    "-e",
    "OP_SERVICE_ACCOUNT_TOKEN=ops_secretvalue",
    "-e",
    "AKF_SSH_AUTHORIZED_KEY=ssh-ed25519 AAAA...",
    "img",
    "claude",
  ];
  assertEquals(redactDebugArgs(args), [
    "run",
    "--rm",
    "-v",
    "/host:/home/node/.claude",
    "-e",
    "CLAUDE_CONFIG_DIR=/home/node/.claude",
    "-e",
    "AKF_SANDBOX=1",
    "-e",
    "OP_SERVICE_ACCOUNT_TOKEN=***",
    "-e",
    "AKF_SSH_AUTHORIZED_KEY=***",
    "img",
    "claude",
  ]);
});

Deno.test("redactDebugArgs: leaves a KEY=VALUE that isn't an -e value untouched", () => {
  // A bare token-looking positional (not preceded by -e) must not be rewritten.
  assertEquals(redactDebugArgs(["cmd", "MY_TOKEN=abc"]), ["cmd", "MY_TOKEN=abc"]);
});
