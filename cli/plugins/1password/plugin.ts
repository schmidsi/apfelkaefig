import { resolveOp } from "../../lib/secrets.ts";
import type { BuiltInPlugin } from "../types.ts";

const ONEPASSWORD_GUIDANCE = `## 1Password inside the sandbox

This project enables the akf 1Password plugin. The sandbox receives only
\`OP_SERVICE_ACCOUNT_TOKEN\`; resolve secrets on demand inside the sandbox with
\`op read\` instead of writing raw secret values to the repo or config.`;

export const onePasswordPlugin: BuiltInPlugin = {
  id: "1password",
  aliases: ["1pw", "op"],
  description: "Forward OP_SERVICE_ACCOUNT_TOKEN and document op read usage inside the sandbox.",
  validateConfig(config) {
    for (const k of Object.keys(config)) {
      if (k !== "enabled") {
        throw new Error(`'plugins.1password' has unknown key '${k}'`);
      }
    }
    if (config.enabled !== true && config.enabled !== false) {
      throw new Error("'plugins.1password.enabled' must be a boolean");
    }
  },
  defaultConfig: { enabled: true },
  transformConfig(base, config, _ctx) {
    if (!config.enabled) return base;
    return {
      ...base,
      secrets: {
        ...(base.secrets ?? {}),
        onepassword: true,
      },
    };
  },
  markerBlocks(_config) {
    return [{
      path: "CLAUDE.md",
      startMarker: "<!-- akf plugin: 1password start -->",
      endMarker: "<!-- akf plugin: 1password end -->",
      contents: ONEPASSWORD_GUIDANCE,
    }];
  },
  // Token injection is implicit-on (this hook also runs when the plugin has
  // no config section — see runUp): inject when a token is found, require it
  // when secrets.onepassword is true, skip when false / AKF_DISABLE_OP=1.
  // Throws SecretsRequiredError / TruncatedTokenError for runUp to surface.
  async runtimeEnv(ctx): Promise<Record<string, string>> {
    const token = await resolveOp({ explicit: ctx.config.secrets?.onepassword });
    if (!token) return {};
    return { OP_SERVICE_ACCOUNT_TOKEN: token };
  },
};
