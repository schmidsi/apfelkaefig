// devcontainer-style variable substitution. Lives in its own module (no
// imports beyond fs.ts) so plugins can use it without creating an import
// cycle through config.ts → plugins.ts.

import { projectSlug } from "./fs.ts";

// Substitute ${localEnv:VAR}, ${localWorkspaceFolder}, ${localWorkspaceFolderBasename},
// ${devcontainerId}. Same dialect as devcontainer.json. ${devcontainerId} is the
// spec's stable per-project id (commonly used in named-volume sources); we resolve
// it to the project slug so it matches the volume-name regex and stays consistent
// with akf's image tag (`<slug>-sandbox`).
export function substitute(
  s: string,
  ctx: { workspaceFolder: string; env?: Record<string, string | undefined> },
): string {
  const env = ctx.env ?? Deno.env.toObject();
  const basename = ctx.workspaceFolder.split("/").filter(Boolean).pop() ?? "";

  let out = s;
  out = out.replace(
    /\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => env[name] ?? "",
  );
  out = out.replaceAll("${localWorkspaceFolder}", ctx.workspaceFolder);
  out = out.replaceAll("${localWorkspaceFolderBasename}", basename);
  out = out.replaceAll("${devcontainerId}", projectSlug(ctx.workspaceFolder));
  return out;
}

// Expand a leading `~` or `~/` to the given home dir. Mid-path tildes are
// left alone — they're not a shell glob target here.
export function expandHome(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}
