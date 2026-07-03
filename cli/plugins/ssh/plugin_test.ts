import { assert, assertEquals, assertThrows } from "@std/assert";
import { resolveKeyPath, sshPlugin } from "./plugin.ts";
import type { ApfelkaefigConfig } from "../../lib/schema.ts";

const ctx = { workspaceDir: "/Users/me/myproj" };

function defaults(): Record<string, unknown> {
  return typeof sshPlugin.defaultConfig === "function"
    ? sshPlugin.defaultConfig(ctx)
    : { ...sshPlugin.defaultConfig };
}

Deno.test("ssh transformConfig: adds host-key volume, published port, and dockerfile", () => {
  const base: ApfelkaefigConfig = { version: 1 };
  const out = sshPlugin.transformConfig!(base, defaults(), ctx);

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

Deno.test("ssh transformConfig: shadows ~/.claude/remote with a native volume", () => {
  // The desktop remote server chmod()s its rpc.sock; virtiofs (the ~/.claude
  // host mount) rejects that, so this subdir needs a native (ext4) volume.
  const out = sshPlugin.transformConfig!({ version: 1 }, defaults(), ctx);
  const vol = (out.mounts ?? []).find((m) => m.target === "/home/node/.claude/remote");
  assert(vol, "remote volume mount missing");
  assertEquals(vol.type, "volume");
  assertEquals(vol.source, "ssh-myproj-remote");
});

Deno.test("ssh transformConfig: hostKeyVolume override wins", () => {
  const out = sshPlugin.transformConfig!(
    { version: 1 },
    { ...defaults(), hostKeyVolume: "my-vol" },
    ctx,
  );
  const vol = (out.mounts ?? []).find((m) => m.target === "/var/lib/akf-ssh");
  assertEquals(vol?.source, "my-vol");
});

Deno.test("ssh transformConfig: idempotent — no duplicate mounts or ports", () => {
  const once = sshPlugin.transformConfig!({ version: 1 }, defaults(), ctx);
  const twice = sshPlugin.transformConfig!(once, defaults(), ctx);
  assertEquals(
    (twice.mounts ?? []).filter((m) => m.target === "/var/lib/akf-ssh").length,
    1,
  );
  assertEquals((twice.ports ?? []).filter((p) => p.container === 22).length, 1);
});

Deno.test("ssh transformConfig: disabled is a no-op", () => {
  const base: ApfelkaefigConfig = { version: 1 };
  const out = sshPlugin.transformConfig!(base, { ...defaults(), enabled: false }, ctx);
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
  // The passwordless 'node' account is locked ('!') by default; with UsePAM no
  // sshd refuses locked accounts, so the entrypoint must unlock it.
  assert(b.contents.includes("passwd -d node"), "node account not unlocked");
  // sshd resets PATH for non-interactive sessions, so `ssh host claude` (how
  // desktop apps launch the remote server) can't find ~/.local/bin/claude
  // without a symlink onto the default PATH.
  assert(
    b.contents.includes("ln -sf /home/node/.local/bin/claude /usr/local/bin/claude"),
    "claude not symlinked onto the non-interactive PATH",
  );
  // The ~/.claude/remote volume mounts root-owned; node must own it to SFTP the
  // remote server in (else "Failed to upload file").
  assert(
    b.contents.includes("chown node:node /home/node/.claude/remote"),
    "remote volume not chowned to node",
  );
});

Deno.test("ssh resolveKeyPath: resolves ${localWorkspaceFolder}", () => {
  assertEquals(
    resolveKeyPath("${localWorkspaceFolder}/.devcontainer/authorized_keys.pub", "/ws/proj"),
    "/ws/proj/.devcontainer/authorized_keys.pub",
  );
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
