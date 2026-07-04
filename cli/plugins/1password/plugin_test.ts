import { assertEquals, assertRejects } from "@std/assert";
import { onePasswordPlugin } from "./plugin.ts";
import { SecretsRequiredError } from "../../lib/secrets.ts";
import type { RunContext } from "../types.ts";
import type { Runner } from "../../lib/container.ts";

const noopRun: Runner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

function ctx(secrets?: { onepassword?: boolean }): RunContext {
  return {
    config: { version: 1, ...(secrets ? { secrets } : {}) },
    workspaceDir: "/tmp/proj",
    command: ["claude"],
    flags: {},
    run: noopRun,
  };
}

// resolveOp reads the process env; stash and restore around each test.
async function withEnvToken(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = Deno.env.get("OP_SERVICE_ACCOUNT_TOKEN");
  const prevDisable = Deno.env.get("AKF_DISABLE_OP");
  try {
    if (value === undefined) Deno.env.delete("OP_SERVICE_ACCOUNT_TOKEN");
    else Deno.env.set("OP_SERVICE_ACCOUNT_TOKEN", value);
    Deno.env.delete("AKF_DISABLE_OP");
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("OP_SERVICE_ACCOUNT_TOKEN");
    else Deno.env.set("OP_SERVICE_ACCOUNT_TOKEN", prev);
    if (prevDisable !== undefined) Deno.env.set("AKF_DISABLE_OP", prevDisable);
  }
}

Deno.test("runtimeEnv: injects the token implicitly when present", async () => {
  await withEnvToken("tok-abc", async () => {
    assertEquals(
      await onePasswordPlugin.runtimeEnv!(ctx()),
      { OP_SERVICE_ACCOUNT_TOKEN: "tok-abc" },
    );
  });
});

Deno.test("runtimeEnv: secrets.onepassword=false opts out even with a token", async () => {
  await withEnvToken("tok-abc", async () => {
    assertEquals(await onePasswordPlugin.runtimeEnv!(ctx({ onepassword: false })), {});
  });
});

Deno.test("runtimeEnv: secrets.onepassword=true without a token throws", async () => {
  await withEnvToken(undefined, async () => {
    // Non-darwin platforms skip the keychain, so a missing env token is final.
    if (Deno.build.os === "darwin") return;
    await assertRejects(
      () => onePasswordPlugin.runtimeEnv!(ctx({ onepassword: true })),
      SecretsRequiredError,
    );
  });
});

Deno.test("runtimeEnv: no token, implicit mode → empty env", async () => {
  await withEnvToken(undefined, async () => {
    if (Deno.build.os === "darwin") return; // keychain could legitimately have one
    assertEquals(await onePasswordPlugin.runtimeEnv!(ctx()), {});
  });
});
