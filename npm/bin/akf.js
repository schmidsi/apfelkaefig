#!/usr/bin/env node
// Tiny shim that execs the platform-specific binary downloaded by
// postinstall.js. Same code path whether invoked as `akf …` or
// `apfelkaefig …` (both bin entries point here).

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const bin = path.join(__dirname, "akf-bin");
if (!fs.existsSync(bin)) {
  console.error(
    "apfelkaefig: binary missing. Postinstall did not complete — re-run\n" +
      "             `npm install -g apfelkaefig` or download from\n" +
      "             https://github.com/schmidsi/apfelkaefig/releases.",
  );
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
