// akf-owned Claude credential lineage.
//
// Why this exists: on macOS, Claude Code refreshes its OAuth token into the
// login Keychain. Sharing (or copying) the host's credential into sandboxes
// forks one refresh-token lineage across two clients — whichever refreshes
// first rotates the other out, and reuse of the stale token can revoke the
// whole family (host logout). So akf maintains its OWN login instead:
//
//   - `akf auth` (or the auto-prompt on `akf up`) runs a one-time interactive
//     `claude` login ON THE HOST with CLAUDE_CONFIG_DIR pointed at akf's state
//     dir. Login writes `.credentials.json` into that dir (even on macOS —
//     only subsequent refreshes go Keychain-only). Host-side because the
//     OAuth paste flow is unreliable through the container TTY.
//   - `akf up` overlay-mounts that file RW into every sandbox. The Linux
//     claude inside reads and rotates it in place, so the lineage
//     self-maintains: short-lived access tokens, rotating refresh token.
//   - The host's own login is never read or touched again.

import { basename, join } from "@std/path";
import { realRunner, type Runner } from "./container.ts";

// Lineages are per *environment*, not per project: a project's
// `claudeConfigDir` (e.g. `~/.claude-ens` for work vs the `~/.claude` default)
// selects which sandbox login it uses. Projects sharing a claudeConfigDir
// share a lineage; the default maps to slug "claude".
export function profileSlug(claudeConfigDir?: string): string {
  if (!claudeConfigDir) return "claude";
  const slug = basename(claudeConfigDir)
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return slug || "claude";
}

// CLAUDE_CONFIG_DIR for the akf-owned login. Lives under XDG state, not
// ~/.claude*, so host `claude` never picks it up by accident.
export function akfProfileDir(home: string, slug = "claude"): string {
  return join(home, ".local", "state", "apfelkaefig", slug);
}

export function akfCredentialsFile(home: string, slug = "claude"): string {
  return join(akfProfileDir(home, slug), ".credentials.json");
}

export type CredentialCheck =
  | { state: "missing" }
  // Exists but unparseable or not the expected shape — treat like missing.
  | { state: "invalid" }
  | { state: "valid"; path: string; expiresAt: number }
  // Access token expired (or about to); the refresh token may still revive it.
  | { state: "expired"; path: string; refreshToken: string };

// Consider a token "expired" slightly early so a sandbox doesn't start with a
// token that dies moments later.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export async function checkCredentials(
  home: string,
  opts: { slug?: string; now?: number } = {},
): Promise<CredentialCheck> {
  const now = opts.now ?? Date.now();
  const path = akfCredentialsFile(home, opts.slug);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return { state: "missing" };
  }
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (
      typeof oauth?.accessToken !== "string" || typeof oauth?.refreshToken !== "string" ||
      typeof oauth?.expiresAt !== "number"
    ) return { state: "invalid" };
    if (oauth.expiresAt <= now + EXPIRY_MARGIN_MS) {
      return { state: "expired", path, refreshToken: oauth.refreshToken };
    }
    return { state: "valid", path, expiresAt: oauth.expiresAt };
  } catch {
    return { state: "invalid" };
  }
}

// Claude Code's public OAuth client id — it appears in every login URL the CLI
// prints. Needed for the standard refresh_token grant below.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Candidate token endpoints, tried in order. Anthropic has been migrating
// console.anthropic.com → platform.claude.com; whichever answers definitively
// (2xx, or an auth-style 4xx) wins. Anything else falls through.
const TOKEN_ENDPOINTS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];

export type RefreshResult = "refreshed" | "auth-needed" | "unavailable";

// Best-effort host-side refresh of an expired credential, writing the rotated
// tokens back to `path` (the same file sandboxes mount, so the lineage stays
// single-source). "auth-needed" = the server rejected the refresh token (dead
// family → a new login is required). "unavailable" = couldn't get a definitive
// answer (offline, endpoint moved) — callers proceed and let the sandbox's own
// claude retry.
//
// Only call this when no sandbox is running: a live box holds the current
// refresh token in memory, and rotating it from the host would trigger the
// same reuse-revocation this module exists to prevent.
export async function refreshCredentials(
  path: string,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResult> {
  let stored: Record<string, unknown>;
  let oauth: Record<string, unknown>;
  try {
    stored = JSON.parse(await Deno.readTextFile(path));
    oauth = stored.claudeAiOauth as Record<string, unknown>;
    if (typeof oauth?.refreshToken !== "string") return "auth-needed";
  } catch {
    return "auth-needed";
  }

  for (const endpoint of TOKEN_ENDPOINTS) {
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      continue; // network error — try the next endpoint
    }
    if (res.ok) {
      const body = await res.json();
      if (typeof body?.access_token !== "string") return "unavailable";
      stored.claudeAiOauth = {
        ...oauth,
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string"
          ? body.refresh_token
          : oauth.refreshToken,
        expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) *
            1000,
      };
      await Deno.writeFile(
        path,
        new TextEncoder().encode(JSON.stringify(stored)),
        { mode: 0o600 },
      );
      return "refreshed";
    }
    await res.body?.cancel();
    // Definitive auth failures mean the refresh token is dead. A 404/5xx means
    // this endpoint isn't it — try the next.
    if (res.status === 400 || res.status === 401 || res.status === 403) return "auth-needed";
  }
  return "unavailable";
}

// Run `claude auth login` on the host, scoped to the akf profile dir. Returns
// true when a usable credential materialized. Host-side because browser +
// paste work natively here, unlike through the container TTY; `auth login`
// (rather than the bare REPL) exits on its own once the login completes.
export async function runAuthWizard(home: string, slug = "claude"): Promise<boolean> {
  const dir = akfProfileDir(home, slug);
  await Deno.mkdir(dir, { recursive: true });
  console.error(
    `akf auth: opening Claude login for the sandbox profile '${slug}' (${dir}).\n` +
      `          The browser uses whichever claude.ai account is signed in — make\n` +
      `          sure it's the right one for '${slug}'.`,
  );
  try {
    const child = new Deno.Command("claude", {
      args: ["auth", "login", "--claudeai"],
      env: { ...Deno.env.toObject(), CLAUDE_CONFIG_DIR: dir },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    await child.status;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error("akf auth: `claude` not found on PATH — install Claude Code first.");
      return false;
    }
    throw err;
  }
  // Trust the credential file, not the exit code: what matters is whether a
  // parseable credential landed in the profile dir. On macOS `claude auth
  // login` stores Keychain-only, so export it to the file sandboxes mount.
  let check = await checkCredentials(home, { slug });
  if (check.state === "missing" || check.state === "invalid") {
    await exportKeychainCredential(dir, akfCredentialsFile(home, slug));
    check = await checkCredentials(home, { slug });
  }
  return check.state === "valid" || check.state === "expired";
}

// macOS stores a custom CLAUDE_CONFIG_DIR's credential under the Keychain
// service "Claude Code-credentials-<first 8 hex of sha256(dir)>" (verified
// empirically: sha256("…/apfelkaefig/claude")[:8] matched the entry created
// by a real login). Copy it into the profile's .credentials.json once — from
// then on the sandbox rotates the file and the Keychain copy goes stale
// unused, which is fine: this lineage belongs to the sandboxes.
export async function exportKeychainCredential(
  configDir: string,
  credPath: string,
  opts: { os?: string; run?: Runner } = {},
): Promise<boolean> {
  if ((opts.os ?? Deno.build.os) !== "darwin") return false;
  const run = opts.run ?? realRunner;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(configDir));
  const suffix = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  const r = await run(
    "security",
    ["find-generic-password", "-s", `Claude Code-credentials-${suffix}`, "-w"],
    { stdout: "piped", stderr: "null" },
  );
  if (r.code !== 0) return false;
  const cred = r.stdout.trim();
  try {
    JSON.parse(cred);
  } catch {
    return false;
  }
  await Deno.writeFile(credPath, new TextEncoder().encode(cred), { mode: 0o600 });
  return true;
}
