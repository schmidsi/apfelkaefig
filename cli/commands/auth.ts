// `akf auth` — (re-)establish a sandbox Claude login. Lineages are per
// environment (the project's `claudeConfigDir`: work vs personal), not per
// project — see cli/lib/claude_creds.ts for why sandboxes get their own
// credential lineage instead of borrowing the host's.

import {
  akfCredentialsFile,
  checkCredentials,
  profileSlug,
  runAuthWizard,
} from "../lib/claude_creds.ts";
import { ConfigError, resolveConfig, substitute } from "../lib/config.ts";

export interface AuthOptions {
  // Re-login even when the current credential still looks healthy.
  force?: boolean;
  // Explicit profile name (e.g. `akf auth --profile claude-ens`). When unset,
  // the current project's claudeConfigDir decides.
  profile?: string;
  cwd?: string;
  home?: string;
}

export async function runAuth(opts: AuthOptions = {}): Promise<number> {
  const home = opts.home ?? Deno.env.get("HOME");
  if (!home) {
    console.error("akf auth: HOME not set");
    return 1;
  }

  let slug: string;
  if (opts.profile) {
    slug = profileSlug(opts.profile);
  } else {
    // No explicit profile: the project in cwd decides which environment's
    // login to establish (drive-by dirs fall back to the default profile).
    try {
      const resolved = await resolveConfig({ cwd: opts.cwd ?? Deno.cwd() });
      const dir = resolved.config.claudeConfigDir;
      slug = profileSlug(
        dir
          ? substitute(dir, {
            workspaceFolder: resolved.workspaceDir,
            env: Deno.env.toObject(),
          })
          : undefined,
      );
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`akf auth: ${err.message}${err.path ? ` (${err.path})` : ""}`);
        return 1;
      }
      throw err;
    }
  }

  const check = await checkCredentials(home, { slug });
  if (check.state === "valid" && !opts.force) {
    console.error(
      `akf auth: sandbox login for profile '${slug}' is healthy (token expires ${
        new Date(check.expiresAt).toLocaleString()
      }).\n          Use --force to log in again anyway.`,
    );
    return 0;
  }
  if (check.state === "expired" && !opts.force) {
    console.error(
      `akf auth: the '${slug}' token is expired but may just need a refresh — ` +
        "`akf up` handles that automatically.\n          Continuing with a fresh login…",
    );
  }

  const ok = await runAuthWizard(home, slug);
  if (!ok) {
    console.error(
      "akf auth: login did not complete — no credential was written to\n" +
        `          ${akfCredentialsFile(home, slug)}. Run \`akf auth\` to retry.`,
    );
    return 1;
  }
  console.error(
    `akf auth: sandbox login for '${slug}' stored. \`akf up\` will use it from now on.`,
  );
  return 0;
}
