import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildRunArgs,
  dockerStatus,
  ensureVolumes,
  projectImageTag,
  resolveImageRef,
} from "./container.ts";
import type { CmdResult, Runner } from "./container.ts";
import type { ResolvedConfig } from "./config.ts";

function fakeRunner(
  responses: Record<string, CmdResult>,
): { run: Runner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    const r = responses[key];
    if (!r) throw new Error(`no fake response for: ${key}`);
    return Promise.resolve(r);
  };
  return { run, calls };
}

function resolved(
  partial: Partial<ResolvedConfig["config"]> = {},
  dir = "/Users/me/proj",
): ResolvedConfig {
  return {
    source: { kind: "defaults", dir },
    workspaceDir: dir,
    config: { version: 1, ...partial },
    warnings: [],
  };
}

Deno.test("projectImageTag derives from workspace basename", () => {
  assertEquals(projectImageTag("/Users/me/Apfelkäfig"), "apfelk-fig-sandbox");
  assertEquals(projectImageTag("/Users/me/MyProj"), "myproj-sandbox");
  assertEquals(projectImageTag("/"), "akf-sandbox");
});

Deno.test("resolveImageRef: registry built-in (no Dockerfile) when image unset", () => {
  const r = resolveImageRef({ version: 1 }, "/p", {
    ref: "ghcr.io/apfelkaefig/base@sha256:abc",
  });
  assertEquals(r.ref, "ghcr.io/apfelkaefig/base@sha256:abc");
  assertEquals(r.needsBuild, false);
  assertEquals(r.dockerfile, undefined);
});

Deno.test("resolveImageRef: embedded built-in triggers build when image unset", () => {
  const r = resolveImageRef({ version: 1 }, "/p", {
    ref: "apfelkaefig-base:abc123",
    dockerfile: "/cache/abc123/Dockerfile",
  });
  assertEquals(r.ref, "apfelkaefig-base:abc123");
  assertEquals(r.needsBuild, true);
  assertEquals(r.dockerfile, "/cache/abc123/Dockerfile");
});

Deno.test("resolveImageRef: string image passes through", () => {
  const r = resolveImageRef({ version: 1, image: "node:22" }, "/p", { ref: "default" });
  assertEquals(r.ref, "node:22");
  assertEquals(r.needsBuild, false);
});

Deno.test("resolveImageRef: dockerfile triggers build with project tag", () => {
  const r = resolveImageRef(
    { version: 1, image: { dockerfile: ".devcontainer/Dockerfile" } },
    "/Users/me/myproj",
    { ref: "default" },
  );
  assertEquals(r.ref, "myproj-sandbox");
  assertEquals(r.needsBuild, true);
  assertEquals(r.dockerfile, ".devcontainer/Dockerfile");
});

Deno.test("buildRunArgs: minimal defaults", () => {
  const out = buildRunArgs({
    resolved: resolved({}),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "ghcr.io/apfelkaefig/base",
    homeDir: "/nonexistent-home",
  });
  assert(out.args[0] === "run");
  assertEquals(out.user, "node");
  assertEquals(out.workspaceFolder, "/workspaces/proj");
  // Workspace mount appears.
  const idx = out.args.indexOf("/Users/me/proj:/workspaces/proj");
  assert(idx > 0, "workspace mount missing");
  // Default command appended at the end.
  const tail = out.args.slice(-3);
  assertEquals(tail, [
    "ghcr.io/apfelkaefig/base",
    "claude",
    "--dangerously-skip-permissions",
  ]);
});

Deno.test("buildRunArgs: custom command + extra env", () => {
  const out = buildRunArgs({
    resolved: resolved({ command: ["bash"] }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
    extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: "tok" },
  });
  assertEquals(out.args.slice(-2), ["img", "bash"]);
  // Token forwarded.
  const envIdx = out.args.findIndex((a) => a === "OP_SERVICE_ACCOUNT_TOKEN=tok");
  assert(envIdx > 0, "token not forwarded");
});

Deno.test("buildRunArgs: renders configured port forwards", () => {
  const out = buildRunArgs({
    resolved: resolved({
      ports: [{ hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" }],
    }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  const idx = out.args.indexOf("127.0.0.1:3247:3247/tcp");
  assert(idx > 0, "port publish value missing");
  assertEquals(out.args[idx - 1], "-p");
});

Deno.test("buildRunArgs: respects user + workspaceFolder overrides", () => {
  const out = buildRunArgs({
    resolved: resolved({ user: "alice", workspaceFolder: "/code" }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  assertEquals(out.user, "alice");
  assertEquals(out.workspaceFolder, "/code");
  // -u alice -w /code
  const u = out.args.indexOf("-u");
  assertEquals(out.args[u + 1], "alice");
  const w = out.args.indexOf("-w");
  assertEquals(out.args[w + 1], "/code");
});

Deno.test("buildRunArgs: drive-by mode skips ~/Downloads and ~/Desktop", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.claude`);
    await Deno.mkdir(`${home}/Downloads`);
    await Deno.mkdir(`${home}/Desktop`);

    const driveBy = buildRunArgs({
      resolved: resolved({}), // source.kind === "defaults"
      workspaceHostPath: "/Users/me/proj",
      imageRef: "img",
      homeDir: home,
    });
    const driveByMounts = driveBy.args.filter((a) => a.startsWith(home));
    assertEquals(driveByMounts, [`${home}/.claude:/home/node/.claude`]);

    const tier2: ResolvedConfig = {
      ...resolved({}),
      source: { kind: "apfelkaefig", path: "/p/.apfelkaefig.json", dir: "/p", raw: { version: 1 } },
    };
    const tier2Args = buildRunArgs({
      resolved: tier2,
      workspaceHostPath: "/Users/me/proj",
      imageRef: "img",
      homeDir: home,
    });
    const tier2Mounts = tier2Args.args.filter((a) => a.startsWith(home));
    assertEquals(tier2Mounts, [
      `${home}/.claude:/home/node/.claude`,
      `${home}/Downloads:/home/node/Downloads:ro`,
      `${home}/Desktop:/home/node/Desktop:ro`,
    ]);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("buildRunArgs: omits -t when tty=false (no-TTY callers)", () => {
  const out = buildRunArgs({
    resolved: resolved({}),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
    tty: false,
  });
  assertEquals(out.args.slice(0, 3), ["run", "--rm", "-i"]);
  assert(!out.args.includes("-it"));
  assert(!out.args.includes("-t"));
});

Deno.test("buildRunArgs: uses -it when tty=true", () => {
  const out = buildRunArgs({
    resolved: resolved({}),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
    tty: true,
  });
  assertEquals(out.args.slice(0, 3), ["run", "--rm", "-it"]);
});

Deno.test("buildRunArgs: dedupes mount targets (config + defaults collision)", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.claude`);
    await Deno.mkdir(`${home}/Downloads`);
    await Deno.mkdir(`${home}/Desktop`);

    // Tier-2 config that explicitly mounts ~/.claude — same target the
    // defaults block would also emit. Without dedupe we'd send `-v` twice
    // and Apple `container` virtiofs returns EBUSY.
    const cfg: ResolvedConfig = {
      source: {
        kind: "devcontainer",
        path: "/p/.devcontainer/devcontainer.json",
        dir: "/p",
        raw: {},
      },
      workspaceDir: "/Users/me/proj",
      config: {
        version: 1,
        mounts: [{ source: `${home}/.claude`, target: "/home/node/.claude" }],
      },
      warnings: [],
    };
    const out = buildRunArgs({
      resolved: cfg,
      workspaceHostPath: "/Users/me/proj",
      imageRef: "img",
      homeDir: home,
    });
    // Count `-v` flag values that resolve to /home/node/.claude as target.
    const claudeMounts = out.args.filter((a, i) =>
      out.args[i - 1] === "-v" && a.includes(":/home/node/.claude")
    );
    assertEquals(claudeMounts.length, 1, "duplicate ~/.claude mount emitted");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("buildRunArgs: volume mount renders as -v name:tgt without host-path check", () => {
  const out = buildRunArgs({
    resolved: {
      source: { kind: "apfelkaefig", path: "/p/.apfelkaefig.json", dir: "/p", raw: { version: 1 } },
      workspaceDir: "/p",
      config: {
        version: 1,
        mounts: [
          { type: "volume", source: "tg-auth", target: "/data" },
          { type: "volume", source: "tg-state", target: "/state", readonly: true },
        ],
      },
      warnings: [],
    },
    workspaceHostPath: "/p",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  const dataIdx = out.args.indexOf("tg-auth:/data");
  assert(dataIdx > 0, "volume mount missing");
  assertEquals(out.args[dataIdx - 1], "-v");
  const stateIdx = out.args.indexOf("tg-state:/state:ro");
  assert(stateIdx > 0, "ro volume mount missing");
});

Deno.test("ensureVolumes: idempotent — swallows 'already exists'", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Error: volume 'tg-auth' already exists",
    });
  };
  await ensureVolumes(
    [{ type: "volume", source: "tg-auth", target: "/x" }],
    run,
  );
  assertEquals(calls, [{ cmd: "container", args: ["volume", "create", "tg-auth"] }]);
});

Deno.test("ensureVolumes: dedupes by name, skips bind mounts", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  await ensureVolumes(
    [
      { type: "volume", source: "v1", target: "/a" },
      { type: "bind", source: "/host", target: "/b" },
      { type: "volume", source: "v1", target: "/c" },
      { type: "volume", source: "v2", target: "/d" },
    ],
    run,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].args, ["volume", "create", "v1"]);
  assertEquals(calls[1].args, ["volume", "create", "v2"]);
});

Deno.test("ensureVolumes: surfaces real failures (non-'exists' stderr)", async () => {
  const run: Runner = () => Promise.resolve({ code: 1, stdout: "", stderr: "permission denied" });
  await assertRejects(
    () => ensureVolumes([{ type: "volume", source: "v1", target: "/x" }], run),
    Error,
    "failed to create volume 'v1'",
  );
});

Deno.test("ensureVolumes: no-op for undefined / empty / no-volume mounts", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  await ensureVolumes(undefined, run);
  await ensureVolumes([], run);
  await ensureVolumes([{ source: "/host", target: "/x" }], run);
  assertEquals(calls.length, 0);
});

Deno.test("buildRunArgs: applies resources caps", () => {
  const out = buildRunArgs({
    resolved: resolved({ resources: { cpus: 4, memory: "8G" } }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  const cpus = out.args.indexOf("--cpus");
  assertEquals(out.args[cpus + 1], "4");
  const mem = out.args.indexOf("--memory");
  assertEquals(out.args[mem + 1], "8G");
});

Deno.test("dockerStatus: 'ok' when both --version and info succeed", async () => {
  const { run } = fakeRunner({
    "docker --version": { code: 0, stdout: "", stderr: "" },
    "docker info": { code: 0, stdout: "", stderr: "" },
  });
  assertEquals(await dockerStatus(run), "ok");
});

Deno.test("dockerStatus: 'missing' when --version fails", async () => {
  const { run } = fakeRunner({
    "docker --version": { code: 127, stdout: "", stderr: "docker: not found" },
  });
  assertEquals(await dockerStatus(run), "missing");
});

Deno.test("dockerStatus: 'daemon-down' when info fails but --version succeeds", async () => {
  const { run } = fakeRunner({
    "docker --version": { code: 0, stdout: "", stderr: "" },
    "docker info": { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
  });
  assertEquals(await dockerStatus(run), "daemon-down");
});
