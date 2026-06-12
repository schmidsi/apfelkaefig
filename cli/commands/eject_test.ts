import { withTmpDir } from "../lib/test_util.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runEject } from "./eject.ts";

Deno.test("eject --bash: emits volume create + -v flag without [[ -e ]] guard", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({
        version: 1,
        image: "node:22",
        mounts: [
          { type: "volume", source: "tg-auth", target: "/auth" },
          { type: "volume", source: "tg-state", target: "/state", readonly: true },
        ],
      }),
    );
    const code = await runEject({ cwd: dir, target: "bash" });
    assertEquals(code, 0);
    const start = await Deno.readTextFile(join(dir, "start.sh"));

    // Pre-create lines, deduped, idempotent.
    assert(
      start.includes("container volume create tg-auth >/dev/null 2>&1 || true"),
      "tg-auth volume create line missing",
    );
    assert(
      start.includes("container volume create tg-state >/dev/null 2>&1 || true"),
      "tg-state volume create line missing",
    );

    // -v flags emitted without an existence guard.
    assert(
      start.includes(`mount_flags+=(-v "tg-auth:/auth")`),
      "tg-auth -v flag missing or wrapped",
    );
    assert(
      start.includes(`mount_flags+=(-v "tg-state:/state:ro")`),
      "tg-state -v flag missing or wrapped",
    );

    // Sanity: volume mount is NOT inside an `[[ -e ... ]]` block — search for
    // the line and confirm no `if [[ -e` immediately precedes it.
    const lines = start.split("\n");
    const volIdx = lines.findIndex((l) => l.includes(`tg-auth:/auth`));
    assert(volIdx > 0);
    assert(
      !lines[volIdx - 1].includes("[[ -e"),
      "volume mount should not be guarded by [[ -e ]]",
    );
  });
});

Deno.test("eject --devcontainer: mountObjToString emits type=volume", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({
        version: 1,
        image: "node:22",
        mounts: [{ type: "volume", source: "tg-auth", target: "/auth" }],
      }),
    );
    const code = await runEject({ cwd: dir, target: "devcontainer" });
    assertEquals(code, 0);
    const dc = JSON.parse(
      await Deno.readTextFile(join(dir, ".devcontainer", "devcontainer.json")),
    );
    const volumeMount = (dc.mounts as string[]).find((m) => m.includes("tg-auth"));
    assert(volumeMount, "tg-auth mount missing from devcontainer.json");
    assert(volumeMount.includes("type=volume"), `expected type=volume, got: ${volumeMount}`);
  });
});

Deno.test("eject --devcontainer: emits forwardPorts", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({
        version: 1,
        image: "node:22",
        ports: [{ hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" }],
      }),
    );
    const code = await runEject({ cwd: dir, target: "devcontainer" });
    assertEquals(code, 0);
    const dc = JSON.parse(
      await Deno.readTextFile(join(dir, ".devcontainer", "devcontainer.json")),
    );
    assertEquals(dc.forwardPorts, [3247]);
  });
});

Deno.test("eject --bash: emits publish flags", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({
        version: 1,
        image: "node:22",
        ports: [{ hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" }],
      }),
    );
    const code = await runEject({ cwd: dir, target: "bash" });
    assertEquals(code, 0);
    const start = await Deno.readTextFile(join(dir, "start.sh"));
    assert(
      start.includes(`publish_flags+=(-p 127.0.0.1:3247:3247/tcp)`),
      "publish flag missing",
    );
    assert(start.includes(`"\${publish_flags[@]}"`), "publish flags not passed to container run");
  });
});

Deno.test("eject: malformed config exits 1 instead of throwing", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({ version: 1, bogusKey: true }),
    );
    const code = await runEject({ cwd: dir, target: "bash" });
    assertEquals(code, 1);
  });
});

Deno.test("eject --devcontainer: claudeConfigDir overrides ~/.claude mount source", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({ version: 1, image: "node:22", claudeConfigDir: "~/.claude-work" }),
    );
    const code = await runEject({ cwd: dir, target: "devcontainer" });
    assertEquals(code, 0);
    const dc = JSON.parse(
      await Deno.readTextFile(join(dir, ".devcontainer", "devcontainer.json")),
    );
    const claudeMount = (dc.mounts as string[]).find((m: string) =>
      m.includes("target=/home/node/.claude,")
    );
    assertEquals(
      claudeMount,
      "source=${localEnv:HOME}/.claude-work,target=/home/node/.claude,type=bind",
    );
  });
});

Deno.test("eject --bash: claudeConfigDir overrides ~/.claude bind mount", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({ version: 1, image: "node:22", claudeConfigDir: "~/.claude-work" }),
    );
    const code = await runEject({ cwd: dir, target: "bash" });
    assertEquals(code, 0);
    const start = await Deno.readTextFile(join(dir, "start.sh"));
    assert(
      start.includes(`mount_flags+=(-v "$HOME/.claude-work:/home/node/.claude")`),
      "claudeConfigDir bind mount missing",
    );
    assert(!start.includes(`"$HOME/.claude:`), "default ~/.claude mount should be replaced");
  });
});
