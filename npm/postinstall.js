#!/usr/bin/env node
// Postinstall: download the matching `akf` binary from the GitHub release
// and drop it next to bin/akf.js. The bin/ shim execs it.
//
// Failure mode: log a clear message and exit 0 so `npm install` doesn't
// abort consumers' installs. The binary will be missing; `akf` calls will
// fail at exec time with a useful error.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const os = require("node:os");
const REPO = "schmidsi/apfelkaefig";
const PKG = require("./package.json");
const VERSION = PKG.version;

function fail(msg) {
  console.error(`apfelkaefig postinstall: ${msg}`);
  process.exit(0);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail(
    `unsupported platform ${process.platform}/${process.arch}. ` +
      `apfelkaefig is darwin/arm64 only — Apple Silicon Macs.`,
  );
}

const target = path.join(__dirname, "bin", "akf-bin");
if (fs.existsSync(target)) process.exit(0); // already installed

const url = `https://github.com/${REPO}/releases/download/v${VERSION}/akf-darwin-arm64`;

console.error(`apfelkaefig: downloading ${url}`);

const tmp = path.join(os.tmpdir(), `akf-${process.pid}.bin`);
const file = fs.createWriteStream(tmp);

function get(u, redirectsLeft = 5) {
  https
    .get(u, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        get(res.headers.location, redirectsLeft - 1);
        return;
      }
      if (res.statusCode !== 200) {
        fail(`download failed: HTTP ${res.statusCode} from ${u}`);
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(tmp, target);
            fs.chmodSync(target, 0o755);
            console.error(`apfelkaefig: installed to ${target}`);
          } catch (err) {
            fail(`could not install binary: ${err.message}`);
          }
        });
      });
    })
    .on("error", (err) => fail(`network error: ${err.message}`));
}

get(url);
