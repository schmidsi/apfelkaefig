import { assert, assertEquals, assertThrows } from "@std/assert";
import { sshPlugin } from "./plugin.ts";
import type { ApfelkaefigConfig } from "../../lib/schema.ts";

const ctx = { workspaceDir: "/Users/me/myproj" };

function defaults(): Record<string, unknown> {
  return typeof sshPlugin.defaultConfig === "function"
    ? sshPlugin.defaultConfig(ctx)
    : { ...sshPlugin.defaultConfig };
}

Deno.test("ssh applyConfig: adds host-key volume, published port, and dockerfile", () => {
  const base: ApfelkaefigConfig = { version: 1 };
  const out = sshPlugin.applyConfig(base, defaults(), ctx);

  assertEquals(out.image, { dockerfile: ".devcontainer/Dockerfile" });

  const vol = (out.mounts ?? []).find((m) => m.target === "/var/lib/akf-ssh");
  assert(vol, "host-key volume mount missing");
  assertEquals(vol.type, "volume");
  assertEquals(vol.source, "ssh-myproj-hostkey");

  const port = (out.ports ?? []).find((p) => p.container === 22);
  assert(port, "published port missing");
  assertEquals(port.hostIp, "127.0.0.1");
  assertEquals(port.host, 2222);
});

Deno.test("ssh applyConfig: hostKeyVolume override wins", () => {
  const out = sshPlugin.applyConfig(
    { version: 1 },
    { ...defaults(), hostKeyVolume: "my-vol" },
    ctx,
  );
  const vol = (out.mounts ?? []).find((m) => m.target === "/var/lib/akf-ssh");
  assertEquals(vol?.source, "my-vol");
});

Deno.test("ssh applyConfig: idempotent — no duplicate mounts or ports", () => {
  const once = sshPlugin.applyConfig({ version: 1 }, defaults(), ctx);
  const twice = sshPlugin.applyConfig(once, defaults(), ctx);
  assertEquals(
    (twice.mounts ?? []).filter((m) => m.target === "/var/lib/akf-ssh").length,
    1,
  );
  assertEquals((twice.ports ?? []).filter((p) => p.container === 22).length, 1);
});

Deno.test("ssh applyConfig: disabled is a no-op", () => {
  const base: ApfelkaefigConfig = { version: 1 };
  const out = sshPlugin.applyConfig(base, { ...defaults(), enabled: false }, ctx);
  assertEquals(out, base);
});

Deno.test("ssh dockerfileBlocks: installs sshd and the foreground entrypoint", () => {
  const blocks = sshPlugin.dockerfileBlocks!(defaults());
  assertEquals(blocks.length, 1);
  const [b] = blocks;
  assertEquals(b.path, ".devcontainer/Dockerfile");
  assertEquals(b.startMarker, "# >>> akf plugin: ssh");
  assert(b.contents.includes("openssh-server"), "missing openssh-server install");
  // Must switch to root: the block may be appended after a Dockerfile ending
  // 'USER node', and apt-get / writes to /etc/ssh need root.
  assert(
    b.contents.indexOf("USER root") < b.contents.indexOf("apt-get"),
    "block must `USER root` before installing packages",
  );
  assert(b.contents.includes("sshd -D -e"), "sshd not run in foreground");
  assert(b.contents.includes("/var/lib/akf-ssh/ssh_host_ed25519_key"), "host key path missing");
  assert(b.contents.includes("AKF_SSH_AUTHORIZED_KEY"), "authorized key env not consumed");
});

Deno.test("ssh validateConfig: rejects unknown keys and bad port", () => {
  assertThrows(
    () => sshPlugin.validateConfig!({ ...defaults(), bogus: 1 }),
    Error,
    "unknown key",
  );
  assertThrows(
    () => sshPlugin.validateConfig!({ ...defaults(), port: 80 }),
    Error,
    "1024 to 65535",
  );
  // Valid config does not throw.
  sshPlugin.validateConfig!(defaults());
});

Deno.test("ssh doctorChecks: fails when the authorized key is missing", async () => {
  const resolved = {
    config: {
      version: 1 as const,
      image: { dockerfile: ".devcontainer/Dockerfile" },
    },
    workspaceDir: "/tmp/does-not-exist-akf",
  };
  const checks = await sshPlugin.doctorChecks!(resolved, {
    ...defaults(),
    authorizedKey: "/tmp/definitely-not-a-real-key.pub",
  });
  const keyCheck = checks.find((c) => c.label === "ssh key");
  assertEquals(keyCheck?.severity, "fail");
});
