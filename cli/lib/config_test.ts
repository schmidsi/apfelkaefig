import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  ConfigError,
  effective,
  findConfig,
  parseConfig,
  resolveConfig,
  substitute,
  validate,
} from "./config.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "akf-config-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("validate accepts a minimal v1 config", () => {
  const c = validate({ version: 1 });
  assertEquals(c.version, 1);
});

Deno.test("validate rejects unknown top-level keys", () => {
  assertThrows(
    () => validate({ version: 1, totallyMadeUp: "x" }),
    ConfigError,
    "unknown top-level key 'totallyMadeUp'",
  );
});

Deno.test("validate rejects missing version", () => {
  assertThrows(() => validate({}), ConfigError, "missing required field 'version'");
});

Deno.test("validate rejects unsupported version", () => {
  assertThrows(() => validate({ version: 2 }), ConfigError, "unsupported version");
});

Deno.test("validate accepts image as string", () => {
  const c = validate({ version: 1, image: "node:22" });
  assertEquals(c.image, "node:22");
});

Deno.test("validate accepts image as { dockerfile }", () => {
  const c = validate({ version: 1, image: { dockerfile: ".devcontainer/Dockerfile" } });
  assertEquals(c.image, { dockerfile: ".devcontainer/Dockerfile" });
});

Deno.test("validate rejects malformed image object", () => {
  assertThrows(
    () => validate({ version: 1, image: { dockerfile: 1 } }),
    ConfigError,
    "'image' must be a string",
  );
  assertThrows(
    () => validate({ version: 1, image: { unknown: "x" } }),
    ConfigError,
    "'image' must be a string",
  );
});

Deno.test("validate accepts mounts and rejects bad ones", () => {
  validate({ version: 1, mounts: [{ source: "/a", target: "/b", readonly: true }] });
  assertThrows(
    () => validate({ version: 1, mounts: [{ source: "/a" }] }),
    ConfigError,
    "requires string 'source' and 'target'",
  );
  assertThrows(
    () => validate({ version: 1, mounts: [{ source: "/a", target: "/b", junk: 1 }] }),
    ConfigError,
    "unknown key 'junk'",
  );
});

Deno.test("validate accepts type=volume with valid name", () => {
  const c = validate({
    version: 1,
    mounts: [{ type: "volume", source: "tg-auth", target: "/x" }],
  });
  assertEquals(c.mounts?.[0].type, "volume");
});

Deno.test("validate rejects unknown mount type", () => {
  assertThrows(
    () => validate({ version: 1, mounts: [{ type: "tmpfs", source: "x", target: "/x" }] }),
    ConfigError,
    "must be 'bind' or 'volume'",
  );
});

Deno.test("validate rejects invalid volume names", () => {
  assertThrows(
    () => validate({ version: 1, mounts: [{ type: "volume", source: "foo bar", target: "/x" }] }),
    ConfigError,
    "valid volume name",
  );
  assertThrows(
    () => validate({ version: 1, mounts: [{ type: "volume", source: "-leading", target: "/x" }] }),
    ConfigError,
    "valid volume name",
  );
});

Deno.test("validate rejects substitutions in volume source", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        mounts: [{ type: "volume", source: "${localEnv:HOME}", target: "/x" }],
      }),
    ConfigError,
    "cannot contain ${...} substitutions",
  );
});

Deno.test("resolveConfig: round-trips type=volume from devcontainer mount strings", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".devcontainer"));
    await Deno.writeTextFile(
      join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        mounts: [
          "source=tg-auth,target=/data,type=volume",
          "source=foo,target=/x,type=volume,readonly",
        ],
      }),
    );
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.config.mounts?.[0], { type: "volume", source: "tg-auth", target: "/data" });
    assertEquals(r.config.mounts?.[1], {
      type: "volume",
      source: "foo",
      target: "/x",
      readonly: true,
    });
  });
});

Deno.test("validate enforces resources shape", () => {
  validate({ version: 1, resources: { cpus: 4, memory: "8G" } });
  assertThrows(
    () => validate({ version: 1, resources: { cpus: 0 } }),
    ConfigError,
    "positive integer",
  );
  assertThrows(
    () => validate({ version: 1, resources: { memory: "lots" } }),
    ConfigError,
    "must match",
  );
});

Deno.test("validate accepts secrets.onepassword as boolean only", () => {
  validate({ version: 1, secrets: { onepassword: false } });
  assertThrows(
    () => validate({ version: 1, secrets: { onepassword: "yes" } }),
    ConfigError,
    "must be a boolean",
  );
});

Deno.test("parseConfig accepts JSONC with comments and trailing commas", () => {
  const text = `{
    // this is a comment
    "version": 1,
    "user": "node",
  }`;
  const c = parseConfig(text);
  assertEquals(c.user, "node");
});

Deno.test("findConfig returns apfelkaefig.json when present", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, ".apfelkaefig.json"), '{"version":1}');
    const found = await findConfig(dir);
    assertEquals(found.apfelkaefig, join(dir, ".apfelkaefig.json"));
    assertEquals(found.devcontainer, undefined);
    assertEquals(found.dir, dir);
  });
});

Deno.test("findConfig walks up to find a parent config", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, ".apfelkaefig.json"), '{"version":1}');
    const sub = join(dir, "a", "b", "c");
    await Deno.mkdir(sub, { recursive: true });
    const found = await findConfig(sub);
    assertEquals(found.apfelkaefig, join(dir, ".apfelkaefig.json"));
    assertEquals(found.dir, dir);
  });
});

Deno.test("findConfig stops at .git boundary without config", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".git"));
    const sub = join(dir, "a");
    await Deno.mkdir(sub);
    const found = await findConfig(sub);
    assertEquals(found.apfelkaefig, undefined);
    assertEquals(found.devcontainer, undefined);
    assertEquals(found.dir, dir);
  });
});

Deno.test("findConfig returns devcontainer when only it exists", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".devcontainer"));
    await Deno.writeTextFile(join(dir, ".devcontainer", "devcontainer.json"), "{}");
    const found = await findConfig(dir);
    assertEquals(found.apfelkaefig, undefined);
    assertEquals(found.devcontainer, join(dir, ".devcontainer", "devcontainer.json"));
  });
});

Deno.test("resolveConfig: apfelkaefig wins over devcontainer and warns", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      '{"version":1,"user":"alice"}',
    );
    await Deno.mkdir(join(dir, ".devcontainer"));
    await Deno.writeTextFile(
      join(dir, ".devcontainer", "devcontainer.json"),
      '{"remoteUser":"bob"}',
    );
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.source.kind, "apfelkaefig");
    assertEquals(r.config.user, "alice");
    assert(r.warnings.some((w) => w.includes("both")));
  });
});

Deno.test("resolveConfig: falls through to devcontainer translation", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".devcontainer"));
    await Deno.writeTextFile(
      join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        remoteUser: "node",
        workspaceFolder: "/workspace",
        build: { dockerfile: "Dockerfile" },
        mounts: [
          "source=${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind",
          "source=/host,target=/in,type=bind,readonly",
        ],
        containerEnv: { CLAUDE_CONFIG_DIR: "/home/node/.claude" },
        remoteEnv: { TOKEN: "${localEnv:TOKEN}" },
      }),
    );
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.source.kind, "devcontainer");
    assertEquals(r.config.user, "node");
    assertEquals(r.config.workspaceFolder, "/workspace");
    assertEquals(r.config.image, { dockerfile: "Dockerfile" });
    assertEquals(r.config.mounts?.length, 2);
    assertEquals(r.config.mounts?.[1].readonly, true);
    assertEquals(r.config.env?.CLAUDE_CONFIG_DIR, "/home/node/.claude");
    assertEquals(r.config.env?.TOKEN, "${localEnv:TOKEN}");
  });
});

Deno.test("resolveConfig: defaults when nothing present", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".git"));
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.source.kind, "defaults");
    assertEquals(r.config.version, 1);
  });
});

Deno.test("resolveConfig: CLI overrides win", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      '{"version":1,"command":["claude"]}',
    );
    const r = await resolveConfig({ cwd: dir, cliOverrides: { command: ["bash"] } });
    assertEquals(r.config.command, ["bash"]);
  });
});

Deno.test("resolveConfig: bad JSONC surfaces as ConfigError", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, ".apfelkaefig.json"), "{ this is not json");
    await assertRejects(() => resolveConfig({ cwd: dir }), ConfigError);
  });
});

Deno.test("substitute resolves localEnv and workspace placeholders", () => {
  const out = substitute(
    "${localWorkspaceFolder}/x ${localWorkspaceFolderBasename} ${localEnv:FOO}",
    { workspaceFolder: "/Users/me/proj", env: { FOO: "bar" } },
  );
  assertEquals(out, "/Users/me/proj/x proj bar");
});

Deno.test("substitute leaves unknown localEnv vars empty", () => {
  const out = substitute("[${localEnv:NOPE}]", {
    workspaceFolder: "/p",
    env: {},
  });
  assertEquals(out, "[]");
});

Deno.test("effective applies defaults", () => {
  const e = effective({
    source: { kind: "defaults", dir: "/p" },
    workspaceDir: "/p",
    config: { version: 1 },
    warnings: [],
  });
  assertEquals(e.user, "node");
  assertEquals(e.command, ["claude", "--dangerously-skip-permissions"]);
  assertEquals(e.resources, { cpus: 2, memory: "4G" });
});

Deno.test("effective splits string command on whitespace", () => {
  const e = effective({
    source: { kind: "defaults", dir: "/p" },
    workspaceDir: "/p",
    config: { version: 1, command: "bash -lc 'echo hi'" },
    warnings: [],
  });
  // Naive whitespace split — quoted args are not preserved. This is documented
  // behavior; users who need quoted args should use the array form.
  assertEquals(e.command, ["bash", "-lc", "'echo", "hi'"]);
});
