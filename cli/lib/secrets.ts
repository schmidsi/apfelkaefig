// Secret injection for the sandbox.
//
// The 1Password integration is implicit-on: if OP_SERVICE_ACCOUNT_TOKEN is
// available (process env or macOS keychain), akf injects it into the container
// so `op read` works inside. Override via `secrets.onepassword: false` in
// config or AKF_DISABLE_OP=1.
//
// Keychain lookup uses `security find-generic-password -s op-agent-vault
// -a service-account -w`. We refuse any value at exactly 128 characters —
// macOS silently truncates SA tokens (~850 chars) when the keychain entry was
// added via the interactive prompt instead of `-w VALUE`. Returning a
// truncated token would surface as a cryptic
// `failed to session.DecodeSACredentials` downstream; better to fail loud.

const KEYCHAIN_SERVICE = "op-agent-vault";
const KEYCHAIN_ACCOUNT = "service-account";
const TRUNCATION_LENGTH = 128;

export type SecretsRunner = (
  cmd: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

const realRunner: SecretsRunner = async (cmd, args) => {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: out.success,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch {
    return { success: false, stdout: "", stderr: "" };
  }
};

export class TruncatedTokenError extends Error {
  constructor() {
    super(
      `OP_SERVICE_ACCOUNT_TOKEN from macOS keychain is exactly ${TRUNCATION_LENGTH} chars — ` +
        `this is the silent-truncation bug. Re-add the entry with \`security add-generic-password ` +
        `-s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w "$TOKEN"\` (inline, not interactive). ` +
        `See skills/1password-agent-secrets/SKILL.md.`,
    );
    this.name = "TruncatedTokenError";
  }
}

export interface FindTokenOpts {
  env?: Record<string, string | undefined>;
  platform?: typeof Deno.build.os;
  run?: SecretsRunner;
}

// Find the OP_SERVICE_ACCOUNT_TOKEN. Resolution order:
//   1. process env (already in shell — typical case)
//   2. macOS keychain via `security find-generic-password`
// Returns null when nothing is found. Throws TruncatedTokenError on the
// 128-char bug.
export async function findOpToken(opts: FindTokenOpts = {}): Promise<string | null> {
  const env = opts.env ?? Deno.env.toObject();
  const platform = opts.platform ?? Deno.build.os;
  const run = opts.run ?? realRunner;

  const fromEnv = env.OP_SERVICE_ACCOUNT_TOKEN;
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv.length === TRUNCATION_LENGTH) throw new TruncatedTokenError();
    return fromEnv;
  }

  if (platform !== "darwin") return null;

  const out = await run("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  if (!out.success) return null;
  const token = out.stdout.replace(/\n+$/, "");
  if (!token) return null;
  if (token.length === TRUNCATION_LENGTH) throw new TruncatedTokenError();
  return token;
}

export interface ResolveOpts extends FindTokenOpts {
  // explicit: undefined = implicit-on if token present; true = required (error
  // if missing); false = disabled.
  explicit?: boolean;
}

export class SecretsRequiredError extends Error {
  constructor() {
    super(
      "secrets.onepassword is true but OP_SERVICE_ACCOUNT_TOKEN was not found in env or " +
        "macOS keychain. Set the token, or remove secrets.onepassword from your config.",
    );
    this.name = "SecretsRequiredError";
  }
}

// Resolve the 1Password token according to the implicit-on / explicit-required
// rules. Errors loudly when explicit-on but missing — plan calls this out
// because security is the top concern.
export async function resolveOp(opts: ResolveOpts = {}): Promise<string | null> {
  const env = opts.env ?? Deno.env.toObject();
  if (env.AKF_DISABLE_OP === "1") return null;
  if (opts.explicit === false) return null;
  const token = await findOpToken(opts);
  if (opts.explicit === true && !token) throw new SecretsRequiredError();
  return token;
}
