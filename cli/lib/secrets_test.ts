import { assertEquals, assertRejects } from "@std/assert";
import {
  findOpToken,
  resolveOp,
  SecretsRequiredError,
  type SecretsRunner,
  TruncatedTokenError,
} from "./secrets.ts";

const ok = (stdout: string): SecretsRunner => () =>
  Promise.resolve({ success: true, stdout, stderr: "" });
const fail = (): SecretsRunner => () =>
  Promise.resolve({ success: false, stdout: "", stderr: "error" });

Deno.test("findOpToken: returns env value when set", async () => {
  const t = await findOpToken({
    env: { OP_SERVICE_ACCOUNT_TOKEN: "abc" },
    platform: "darwin",
    run: fail(),
  });
  assertEquals(t, "abc");
});

Deno.test("findOpToken: env value at 128 chars throws TruncatedTokenError", async () => {
  await assertRejects(
    () =>
      findOpToken({
        env: { OP_SERVICE_ACCOUNT_TOKEN: "x".repeat(128) },
        platform: "darwin",
      }),
    TruncatedTokenError,
  );
});

Deno.test("findOpToken: falls back to keychain on darwin", async () => {
  const t = await findOpToken({
    env: {},
    platform: "darwin",
    run: ok("kctoken\n"),
  });
  assertEquals(t, "kctoken");
});

Deno.test("findOpToken: keychain at 128 chars throws TruncatedTokenError", async () => {
  await assertRejects(
    () =>
      findOpToken({
        env: {},
        platform: "darwin",
        run: ok("y".repeat(128)),
      }),
    TruncatedTokenError,
  );
});

Deno.test("findOpToken: returns null when keychain miss", async () => {
  const t = await findOpToken({ env: {}, platform: "darwin", run: fail() });
  assertEquals(t, null);
});

Deno.test("findOpToken: skips keychain on non-darwin", async () => {
  let called = false;
  const t = await findOpToken({
    env: {},
    platform: "linux",
    run: () => {
      called = true;
      return Promise.resolve({ success: true, stdout: "x", stderr: "" });
    },
  });
  assertEquals(t, null);
  assertEquals(called, false);
});

Deno.test("resolveOp: AKF_DISABLE_OP=1 short-circuits", async () => {
  const r = await resolveOp({
    env: { AKF_DISABLE_OP: "1", OP_SERVICE_ACCOUNT_TOKEN: "abc" },
    platform: "darwin",
    explicit: true,
  });
  assertEquals(r.status, "explicit-disabled");
  assertEquals(r.token, null);
});

Deno.test("resolveOp: explicit:false disables even when token present", async () => {
  const r = await resolveOp({
    env: { OP_SERVICE_ACCOUNT_TOKEN: "abc" },
    platform: "darwin",
    explicit: false,
  });
  assertEquals(r.status, "explicit-off");
  assertEquals(r.token, null);
});

Deno.test("resolveOp: explicit:true errors when no token", async () => {
  await assertRejects(
    () => resolveOp({ env: {}, platform: "darwin", run: fail(), explicit: true }),
    SecretsRequiredError,
  );
});

Deno.test("resolveOp: implicit-on injects when token present", async () => {
  const r = await resolveOp({
    env: { OP_SERVICE_ACCOUNT_TOKEN: "abc" },
    platform: "darwin",
  });
  assertEquals(r.status, "injected");
  assertEquals(r.token, "abc");
});

Deno.test("resolveOp: implicit-off when no token, no error", async () => {
  const r = await resolveOp({ env: {}, platform: "darwin", run: fail() });
  assertEquals(r.status, "implicit-off-no-token");
  assertEquals(r.token, null);
});
