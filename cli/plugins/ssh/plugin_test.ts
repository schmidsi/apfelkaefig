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
  // Terminals SendEnv these so agents in the box detect hyperlink support
  // (OSC 8 clickable links); sshd drops them without AcceptEnv.
  assert(
    b.contents.includes("AcceptEnv COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION"),
    "terminal-identity env not accepted by sshd",
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

// --- run hooks (--serve) ---

import { withTmpDir } from "../../lib/test_util.ts";
import type { RunContext } from "../types.ts";
import type { Runner } from "../../lib/container.ts";

function runCtx(
  overrides: Partial<RunContext> & { run: Runner },
): RunContext {
  return {
    config: { version: 1 },
    workspaceDir: "/Users/me/myproj",
    command: ["claude"],
    flags: {},
    ...overrides,
  };
}

const noopRun: Runner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

Deno.test("ssh containerName: claims only in --serve mode, with a path hash", () => {
  assertEquals(sshPlugin.containerName!(runCtx({ run: noopRun })), undefined);
  const name = sshPlugin.containerName!(runCtx({ run: noopRun, flags: { serve: true } }));
  assert(name && /^akf-serve-myproj-[0-9a-f]{8}$/.test(name), `unexpected name: ${name}`);
  // Same basename, different path → different serve box name.
  const other = sshPlugin.containerName!(
    runCtx({ run: noopRun, flags: { serve: true }, workspaceDir: "/Users/me/oss/myproj" }),
  );
  assert(name !== other, "same-basename projects collided on serve container name");
});

Deno.test("ssh preRun: no-op without the serve flag", async () => {
  const result = await sshPlugin.preRun!(runCtx({ run: noopRun }));
  assertEquals(result, { action: "continue" });
});

Deno.test("ssh preRun: missing authorized key exits 1", async () => {
  await withTmpDir(async (dir) => {
    const result = await sshPlugin.preRun!(runCtx({
      run: noopRun,
      workspaceDir: dir,
      flags: { serve: true },
      config: {
        version: 1,
        plugins: {
          ssh: { enabled: true, authorizedKey: `${dir}/nope.pub`, port: 2222 },
        },
      },
    }));
    assertEquals(result, { action: "exit", code: 1 });
  });
});

Deno.test("ssh preRun: serve clears the orphan and returns run overrides", async () => {
  await withTmpDir(async (dir) => {
    const keyPath = `${dir}/key.pub`;
    await Deno.writeTextFile(keyPath, "ssh-ed25519 AAAA test@host\n");
    const calls: string[][] = [];
    const run: Runner = (_cmd, args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const c = runCtx({
      run,
      workspaceDir: dir,
      flags: { serve: true },
      config: {
        version: 1,
        plugins: { ssh: { enabled: true, authorizedKey: keyPath, port: 2222 } },
      },
    });
    const result = await sshPlugin.preRun!(c);
    assert(result.action === "continue", `expected continue, got ${result.action}`);
    assertEquals(result.overrides, {
      entrypoint: "/usr/local/bin/akf-sshd",
      command: [],
      user: "root",
      tty: false,
      stopByNameOnInterrupt: true,
    });
    const rm = calls.find((a) => a[0] === "rm");
    assertEquals(rm, ["rm", "-f", sshPlugin.containerName!(c)!]);
  });
});

Deno.test("ssh runtimeEnv: injects the authorized key in serve mode only", async () => {
  await withTmpDir(async (dir) => {
    const keyPath = `${dir}/key.pub`;
    await Deno.writeTextFile(keyPath, "ssh-ed25519 AAAA test@host\n");
    const config = {
      version: 1 as const,
      plugins: { ssh: { enabled: true, authorizedKey: keyPath, port: 2222 } },
    };
    assertEquals(
      await sshPlugin.runtimeEnv!(runCtx({ run: noopRun, workspaceDir: dir, config })),
      {},
    );
    assertEquals(
      await sshPlugin.runtimeEnv!(
        runCtx({ run: noopRun, workspaceDir: dir, config, flags: { serve: true } }),
      ),
      { AKF_SSH_AUTHORIZED_KEY: "ssh-ed25519 AAAA test@host" },
    );
  });
});

Deno.test("resolveKeyPath: leading ~ expands like the run path now", () => {
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(resolveKeyPath("~/x.pub"), `${home}/x.pub`);
  assertEquals(resolveKeyPath("${localEnv:HOME}/x.pub"), `${home}/x.pub`);
});
