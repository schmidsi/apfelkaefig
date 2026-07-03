import { withTmpDir } from "./test_util.ts";
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

Deno.test("validate accepts canonical plugin config object", () => {
  const c = validate({ version: 1, plugins: { "1password": { enabled: true } } });
  assertEquals(c.plugins?.["1password"]?.enabled, true);
});

Deno.test("validate accepts ports", () => {
  const c = validate({
    version: 1,
    ports: [{ hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" }],
  });
  assertEquals(c.ports?.[0], {
    hostIp: "127.0.0.1",
    host: 3247,
    container: 3247,
    protocol: "tcp",
  });
});

Deno.test("validate rejects malformed ports", () => {
  assertThrows(
    () => validate({ version: 1, ports: [{ host: 0, container: 3247 }] }),
    ConfigError,
    "ports[0].host",
  );
  assertThrows(
    () => validate({ version: 1, ports: [{ host: 3247, container: 3247, protocol: "http" }] }),
    ConfigError,
    "protocol",
  );
});

Deno.test("validate rejects plugin array shape", () => {
  assertThrows(
    () => validate({ version: 1, plugins: ["1password"] }),
    ConfigError,
    "'plugins' must be an object",
  );
});

Deno.test("validate rejects plugin aliases in config", () => {
  assertThrows(
    () => validate({ version: 1, plugins: { "1pw": { enabled: true } } }),
    ConfigError,
    "must use canonical plugin id '1password'",
  );
});

Deno.test("validate rejects malformed plugin settings", () => {
  assertThrows(
    () => validate({ version: 1, plugins: { "1password": { enabled: "yes" } } }),
    ConfigError,
    "'plugins.1password.enabled' must be a boolean",
  );
  assertThrows(
    () => validate({ version: 1, plugins: { "1password": { enabled: true, extra: 1 } } }),
    ConfigError,
    "unknown key 'extra'",
  );
});

Deno.test("validate accepts crit plugin config", () => {
  const c = validate({
    version: 1,
    plugins: {
      crit: {
        enabled: true,
        agentIntegration: "claude-code",
        installMethod: "pinned-release",
        version: "v0.13.0",
        port: 3247,
      },
    },
  });
  assertEquals(c.plugins?.crit?.version, "v0.13.0");
});

Deno.test("validate rejects malformed crit plugin config", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          crit: {
            enabled: true,
            agentIntegration: "codex",
            installMethod: "pinned-release",
            version: "v0.13.0",
            port: 3247,
          },
        },
      }),
    ConfigError,
    "agentIntegration",
  );
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          crit: {
            enabled: true,
            agentIntegration: "claude-code",
            installMethod: "pinned-release",
            version: "latest",
            port: 3247,
          },
        },
      }),
    ConfigError,
    "version",
  );
});

Deno.test("validate accepts telegram plugin config", () => {
  const c = validate({
    version: 1,
    plugins: {
      telegram: {
        enabled: true,
        repo: "https://github.com/gskril/telegram-cli.git",
        sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
        storage: "instance",
        userIsolation: false,
      },
    },
  });
  assertEquals(c.plugins?.telegram?.storage, "instance");
});

Deno.test("validate rejects non-https telegram repo", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "git@github.com:gskril/telegram-cli.git",
            sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
            storage: "instance",
            userIsolation: false,
          },
        },
      }),
    ConfigError,
    "must be an https git URL",
  );
});

Deno.test("validate rejects telegram sha that is not 40-hex", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "https://github.com/gskril/telegram-cli.git",
            sha: "abc123",
            storage: "instance",
            userIsolation: false,
          },
        },
      }),
    ConfigError,
    "40-char lowercase hex",
  );
});

Deno.test("validate rejects telegram storage outside the enum", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "https://github.com/gskril/telegram-cli.git",
            sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
            storage: "tmpfs",
            userIsolation: false,
          },
        },
      }),
    ConfigError,
    "storage",
  );
});

Deno.test("validate rejects telegram userIsolation=true with storage=host", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "https://github.com/gskril/telegram-cli.git",
            sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
            storage: "host",
            userIsolation: true,
          },
        },
      }),
    ConfigError,
    "cannot be true when storage is 'host'",
  );
});

Deno.test("validate rejects telegram unknown keys", () => {
  assertThrows(
    () =>
      validate({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "https://github.com/gskril/telegram-cli.git",
            sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
            storage: "instance",
            userIsolation: false,
            mystery: 1,
          },
        },
      }),
    ConfigError,
    "unknown key 'mystery'",
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
    assertEquals(r.config.image, { dockerfile: join(dir, ".devcontainer", "Dockerfile") });
    assertEquals(r.config.mounts?.length, 2);
    assertEquals(r.config.mounts?.[1].readonly, true);
    assertEquals(r.config.env?.CLAUDE_CONFIG_DIR, "/home/node/.claude");
    assertEquals(r.config.env?.TOKEN, "${localEnv:TOKEN}");
  });
});

Deno.test("resolveConfig: devcontainer build.dockerfile resolves relative to .devcontainer/", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".devcontainer"));
    await Deno.writeTextFile(
      join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ build: { dockerfile: "Dockerfile" } }),
    );
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.config.image, { dockerfile: join(dir, ".devcontainer", "Dockerfile") });
  });
});

Deno.test("resolveConfig: devcontainer build.dockerfile preserves absolute paths", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".devcontainer"));
    const abs = "/etc/Dockerfile";
    await Deno.writeTextFile(
      join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ build: { dockerfile: abs } }),
    );
    const r = await resolveConfig({ cwd: dir });
    assertEquals(r.config.image, { dockerfile: abs });
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

Deno.test("substitute resolves ${devcontainerId} to the project slug", () => {
  // Dots and other non-slug chars in the folder name are normalized, so the
  // result is a valid Apple `container` volume name.
  const out = substitute("claude-code-bashhistory-${devcontainerId}", {
    workspaceFolder: "/Users/schmidsi/Repos/@schmidsi/ses.box",
    env: {},
  });
  assertEquals(out, "claude-code-bashhistory-ses.box");
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

Deno.test("validate accepts claudeConfigDir as a string", () => {
  const c = validate({ version: 1, claudeConfigDir: "~/.claude-work" });
  assertEquals(c.claudeConfigDir, "~/.claude-work");
});

Deno.test("validate rejects non-string claudeConfigDir", () => {
  assertThrows(
    () => validate({ version: 1, claudeConfigDir: 42 }),
    ConfigError,
    "'claudeConfigDir' must be a string",
  );
});

Deno.test("effective exposes claudeConfigDir when set, undefined otherwise", () => {
  const undef = effective({
    source: { kind: "defaults", dir: "/p" },
    workspaceDir: "/p",
    config: { version: 1 },
    warnings: [],
  });
  assertEquals(undef.claudeConfigDir, undefined);

  const set = effective({
    source: { kind: "defaults", dir: "/p" },
    workspaceDir: "/p",
    config: { version: 1, claudeConfigDir: "~/.claude-work" },
    warnings: [],
  });
  assertEquals(set.claudeConfigDir, "~/.claude-work");
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
