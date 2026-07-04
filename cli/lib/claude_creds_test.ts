import { assert, assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import {
  akfCredentialsFile,
  akfProfileDir,
  checkCredentials,
  refreshCredentials,
} from "./claude_creds.ts";
import { withTmpDir } from "./test_util.ts";

const NOW = 1_700_000_000_000;

function credJson(expiresAt: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...extra,
    },
  });
}

async function writeCred(home: string, content: string): Promise<string> {
  const path = akfCredentialsFile(home);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  return path;
}

Deno.test("akfProfileDir/akfCredentialsFile: under XDG state, not ~/.claude*", () => {
  assertEquals(akfProfileDir("/h"), "/h/.local/state/apfelkaefig/claude");
  assertEquals(akfCredentialsFile("/h"), "/h/.local/state/apfelkaefig/claude/.credentials.json");
});

Deno.test("checkCredentials: missing when no file", async () => {
  await withTmpDir(async (home) => {
    assertEquals(await checkCredentials(home, NOW), { state: "missing" });
  });
});

Deno.test("checkCredentials: invalid on garbage or wrong shape", async () => {
  await withTmpDir(async (home) => {
    await writeCred(home, "not-json");
    assertEquals((await checkCredentials(home, NOW)).state, "invalid");
    await writeCred(home, JSON.stringify({ claudeAiOauth: { accessToken: 5 } }));
    assertEquals((await checkCredentials(home, NOW)).state, "invalid");
  });
});

Deno.test("checkCredentials: valid when the token has real time left", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW + 3_600_000));
    assertEquals(await checkCredentials(home, NOW), {
      state: "valid",
      path,
      expiresAt: NOW + 3_600_000,
    });
  });
});

Deno.test("checkCredentials: expired when past — or within the safety margin", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW + 60_000)); // < 5 min margin
    assertEquals(await checkCredentials(home, NOW), {
      state: "expired",
      path,
      refreshToken: "rt-old",
    });
  });
});

Deno.test("refreshCredentials: rotates tokens in place, preserving extra fields", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW - 1000));
    const calls: string[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const body = JSON.parse(String(init?.body));
      assertEquals(body.grant_type, "refresh_token");
      assertEquals(body.refresh_token, "rt-old");
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    assertEquals(await refreshCredentials(path, fetchFn), "refreshed");
    assertEquals(calls.length, 1);
    const written = JSON.parse(await Deno.readTextFile(path)).claudeAiOauth;
    assertEquals(written.accessToken, "at-new");
    assertEquals(written.refreshToken, "rt-new");
    assert(written.expiresAt > Date.now() + 3_000_000, "expiresAt should be ~1h out");
    assertEquals(written.subscriptionType, "max"); // extra fields preserved
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  });
});

Deno.test("refreshCredentials: auth-needed on a definitive 4xx", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW - 1000));
    const fetchFn = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      )) as typeof fetch;
    assertEquals(await refreshCredentials(path, fetchFn), "auth-needed");
    // File untouched.
    assertEquals(JSON.parse(await Deno.readTextFile(path)).claudeAiOauth.accessToken, "at-old");
  });
});

Deno.test("refreshCredentials: unavailable when endpoints 404 or the network fails", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW - 1000));
    let n = 0;
    const notFound = (() => {
      n++;
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as typeof fetch;
    assertEquals(await refreshCredentials(path, notFound), "unavailable");
    assertEquals(n, 2, "404 should fall through to the next endpoint");
    const offline = (() => Promise.reject(new TypeError("dns"))) as typeof fetch;
    assertEquals(await refreshCredentials(path, offline), "unavailable");
  });
});

Deno.test("refreshCredentials: 404 on the first endpoint, success on the second", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, credJson(NOW - 1000));
    let n = 0;
    const fetchFn = (() => {
      n++;
      if (n === 1) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "at-new", expires_in: 60 }), { status: 200 }),
      );
    }) as typeof fetch;
    assertEquals(await refreshCredentials(path, fetchFn), "refreshed");
    const written = JSON.parse(await Deno.readTextFile(path)).claudeAiOauth;
    // No refresh_token in the response → keep the old one.
    assertEquals(written.refreshToken, "rt-old");
  });
});

Deno.test("refreshCredentials: auth-needed when the file has no refresh token", async () => {
  await withTmpDir(async (home) => {
    const path = await writeCred(home, JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    const fetchFn = (() => {
      throw new Error("must not be called");
    }) as typeof fetch;
    assertEquals(await refreshCredentials(path, fetchFn), "auth-needed");
  });
});
