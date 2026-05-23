import type { BuiltInPlugin } from "../types.ts";

const ONEPASSWORD_GUIDANCE = `## 1Password inside the sandbox

This project enables the akf 1Password plugin. The sandbox receives only
\`OP_SERVICE_ACCOUNT_TOKEN\`; resolve secrets on demand inside the sandbox with
\`op read\` instead of writing raw secret values to the repo or config.`;

export const onePasswordPlugin: BuiltInPlugin = {
  id: "1password",
  aliases: ["1pw", "op"],
  description: "Forward OP_SERVICE_ACCOUNT_TOKEN and document op read usage inside the sandbox.",
  defaultConfig: { enabled: true },
  applyConfig(base, config) {
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
};
