// `akf auth` — (re-)establish the sandbox's own Claude login. See
// cli/lib/claude_creds.ts for why sandboxes get their own credential lineage
// instead of borrowing the host's.

import { akfCredentialsFile, checkCredentials, runAuthWizard } from "../lib/claude_creds.ts";

export interface AuthOptions {
  // Re-login even when the current credential still looks healthy.
  force?: boolean;
  home?: string;
}

export async function runAuth(opts: AuthOptions = {}): Promise<number> {
  const home = opts.home ?? Deno.env.get("HOME");
  if (!home) {
    console.error("akf auth: HOME not set");
    return 1;
  }

  const check = await checkCredentials(home);
  if (check.state === "valid" && !opts.force) {
    console.error(
      `akf auth: sandbox login is healthy (token expires ${
        new Date(check.expiresAt).toLocaleString()
      }).\n          Use --force to log in again anyway.`,
    );
    return 0;
  }
  if (check.state === "expired" && !opts.force) {
    console.error(
      "akf auth: the sandbox token is expired but may just need a refresh — " +
        "`akf up` handles that automatically.\n          Continuing with a fresh login…",
    );
  }

  const ok = await runAuthWizard(home);
  if (!ok) {
    console.error(
      "akf auth: login did not complete — no credential was written to\n" +
        `          ${akfCredentialsFile(home)}. Run \`akf auth\` to retry.`,
    );
    return 1;
  }
  console.error("akf auth: sandbox login stored. `akf up` will use it from now on.");
  return 0;
}
