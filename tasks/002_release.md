# Plan: v0.2.0 release

## Context

First public release. Version is `0.2.0-dev` in `deno.json` → first tag is **`v0.2.0`**.
Earlier drafts of this plan targeted `v0.1` and assumed Docker + a `src/` layout — both are
stale. Reality as of this rewrite:

- Code lives under `cli/` (`cli/main.ts`, `cli/commands/*`, `cli/lib/*`), **not** `src/`.
- Docker is **gone**. Images build via Apple `container build` straight into `container`'s
  store (commit `bcbde2c`). Nothing in the release path may install or require Docker.
- `akf doctor` **exists** (`cli/commands/doctor.ts`) and already hard-fails on
  `container < 1.0` (`MIN_CONTAINER_MAJOR = 1`, `MIN_CONTAINER_MINOR = 0`).

Decisions locked for this release:

- **GitHub namespace:** `schmidsi/apfelkaefig` (not an org). Clone URL, Pages, ghcr.io path,
  and all `gh` commands use `schmidsi`.
- **Domain:** `apfelkaefig.com` — owned, on DNSimple. `.sh` is not used. The `$schema` URL
  stays `https://apfelkaefig.com/schema/v1.json`.
- **Website:** GitHub Pages (serves the landing page *and* the schema).
- **npm package:** `apfelkaefig` (name confirmed free).
- **ghcr.io base image:** ship it — it removes the ~1–2 min first-`akf up` local build.

Do these roughly in order; each unblocks the next. Optional ordering is noted.

---

## 1. Doc rot cleanup (blocker — do first)

These docs still describe the pre-`bcbde2c` world and the old `src/` layout:

- **`image/README.md`** — "Docker is required on the host for this MVP path" and the
  `docker build -t … image/` override example are wrong. Rewrite around `container build`;
  `AKF_BASE_IMAGE=<ref>` override stays but the example should use `container build`.
- **`README.md`** — clone URL says `github.com/ApfelKaefig/apfelkaefig`; change to
  `github.com/schmidsi/apfelkaefig`. Bump "Pre-release (v0.2)" wording once tagged.
- **This file** — done (you're reading the rewrite).

---

## 2. GitHub Pages site + schema hosting

The site is not just marketing: the config `$schema` resolves to
`https://apfelkaefig.com/schema/v1.json`, so *something* must serve that path or IDE
autocomplete for `.apfelkaefig.json` breaks.

- Publish from `schmidsi/apfelkaefig` — either `/docs` on `main` or a `gh-pages` branch.
- Serve `schema/v1.json` at `/schema/v1.json` (copy or symlink during the Pages build).
- Landing page: one screen is fine — name, one-liner, install snippet, link to repo.
  Can grow later.
- Custom domain: add `apfelkaefig.com` in Pages settings; create the DNSimple records
  (`ALIAS`/`CNAME` for apex → `schmidsi.github.io`, or the four A records). Add a
  `CNAME` file to the Pages source. Enable "Enforce HTTPS".
- Verify `curl https://apfelkaefig.com/schema/v1.json` returns the schema before tagging.

---

## 3. GitHub repo metadata

One-shot, run from macOS (no push needed):

```bash
gh repo edit schmidsi/apfelkaefig \
  --description "Disposable dev sandboxes on Apple Silicon, safe to point coding agents at." \
  --homepage "https://apfelkaefig.com" \
  --add-topic apple-silicon \
  --add-topic sandbox \
  --add-topic claude-code \
  --add-topic coding-agents \
  --add-topic dev-environment \
  --add-topic apple-container
```

Optional:

- Social preview image (1280×640) — name + apple-in-cage glyph.
- Pinned issue for known Apple `container` quirks we work around, to pre-empt bug reports.

---

## 4. `akf doctor` — confirm, don't rebuild

`akf doctor` already checks platform (`darwin/arm64`), `container ≥ 1.0` (hard fail),
config resolution, base-image cache, and 1Password (only when `secrets.onepassword: true`).

Remaining work:

- Confirm the version gate is run as a **preflight inside `akf up`** (and `init`), not only
  in `akf doctor`. If `up` doesn't already short-circuit on a missing/old `container`, wire
  the shared check in so a stale machine fails with a clear message instead of a raw
  `container` error.
- No Docker check (Docker is no longer a dependency — remove any lingering mention).

---

## 5. CI (GitHub Actions)

Runner: **`macos-14`** (Apple Silicon) so the compiled binary matches what users install.
Install Deno with `denoland/setup-deno@v2`; cache `~/.cache/deno`. **No Docker step.**

**`.github/workflows/ci.yml`** — on push/PR:

```
- deno fmt --check
- deno lint
- deno task check        # deno check cli/**/*.ts  (add task if missing)
- deno task test
- deno task compile      # smoke: ensure ./dist/akf builds
```

Note: tests that shell out to `container` can't run on GitHub runners (no Apple
`container` there) — keep those behind a guard or mark them integration-only so CI stays
green. Unit tests for config/markers/schema/fs run fine.

**`.github/workflows/release.yml`** — on tag `v*`:

```
- deno task compile
- Upload dist/akf to the GitHub Release
- Build + push ghcr.io base image (see §7)
- Publish apfelkaefig to npm (see §6)
```

---

## 6. npm distribution

Single package `apfelkaefig` (Apple-Silicon-only, so no multi-target
optionalDependencies dance).

```
npm/
├── package.json        # "bin": { "akf": "./bin/akf.mjs", "apfelkaefig": "./bin/akf.mjs" }
├── bin/akf.mjs         # Node shim: verify platform, exec the bundled binary
└── vendor/akf          # macOS-arm64 binary, populated at release time
```

`bin/akf.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("apfelkaefig requires macOS on Apple Silicon.");
  process.exit(1);
}
execFileSync(new URL("../vendor/akf", import.meta.url), process.argv.slice(2), {
  stdio: "inherit",
});
```

Release workflow copies `dist/akf` → `npm/vendor/`, syncs `npm/package.json` version from
`deno.json` (drop the `-dev` suffix on tag), then `npm publish` from `npm/` with
`NODE_AUTH_TOKEN`. Payoff: `npx apfelkaefig init` works without a clone.

---

## 7. ghcr.io base image

Goal: skip the ~1–2 min local `container build` on a user's **first `akf up`** (it does
*not* affect `akf init`, which writes only files).

- Tag: `ghcr.io/schmidsi/apfelkaefig-base:<hash>` where `<hash>` is the existing
  content-hash of the embedded Dockerfile (same scheme as the local
  `apfelkaefig-base:<hash>` tag), plus a moving `:latest`.
- Build in the release workflow. Apple `container` can pull arm64 OCI images from ghcr.io;
  arm64-only is fine. Note: GitHub runners have no Apple `container`, so the *publish* path
  builds the OCI image with a standard arm64 builder (e.g. `docker buildx`/`buildah` in CI
  only — this is CI tooling, not a host dependency) and pushes it. The host still never
  needs Docker.
- `baseimage.ts` resolution order: if the content-hashed tag is pullable from ghcr.io, pull
  it; else fall back to the embedded local `container build`. `AKF_BASE_IMAGE` keeps
  overriding everything.
- Make the package public on ghcr.io so unauthenticated `akf up` can pull.

If this turns out fiddly, it's the safest item to defer past `v0.2.0` — the local build
already works. Ship it only if it lands clean.

---

## 8. Demo tape (vhs)

Rewrite around the actual default flow (`akf up`), not the old `build.sh`/`start.sh`
(those are the `akf eject --bash` path now). Add `demo.tape` + `demo.gif` at repo root:

```
Output demo.gif
Set FontSize 14
Set Width 1000
Set Height 600

Type "cd ~/code/my-project"
Enter
Type "akf up 'summarize this repo'"
Enter
Sleep 6s
```

Commit the `.tape`; regenerate `.gif` via `vhs demo.tape` (or in CI on tag, uploaded as a
release asset). Embed in README under "Use".

---

## 9. Loose ends

- **`assets/chrome-bridge/`** — referenced from SKILL.md notes but not shipped. For
  `v0.2.0`: **drop the dangling reference** from SKILL.md; revisit the CDP bridge as a
  later feature. (Don't ship a doc pointer to something that doesn't exist.)
- **`CHANGELOG.md`** — start it on the first tag. A single `## v0.2.0` entry linking the
  GitHub Release notes is enough.
- **Verify the `deno.json` version import survives `deno compile`.** Run
  `deno task compile && ./dist/akf --version` on the host once. If the JSON import breaks
  under `deno compile`, inject the version at compile time instead.
- **`tasks/` is internal** — not part of the shipped scaffold (templates don't include it).
  No action; just don't let it leak into `init` output.

---

## Recommended order

1. §1 doc rot (unblocks everything; small).
2. §2 Pages + schema (verify the `$schema` URL resolves).
3. §4 confirm `up` preflight, §3 repo metadata (cheap, parallel).
4. §5 CI green on `main`.
5. §6 npm + §7 ghcr.io in the release workflow.
6. §8 demo GIF, §9 cleanup.
7. `git tag v0.2.0` → release fires.

## Definition of done for v0.2.0

- `image/README.md` + README clone URL un-rotted; no Docker references anywhere. ✅ when done
- `https://apfelkaefig.com/schema/v1.json` resolves over HTTPS.
- `akf up` on a machine with `container < 1.0` (or missing) fails with a clear message.
- CI green on `main` (`fmt`, `lint`, `check`, `test`, `compile`).
- `git tag v0.2.0` uploads the `akf` binary, publishes `apfelkaefig` to npm, and (if it
  landed clean) pushes the ghcr.io base image.
- `npx apfelkaefig init` works end-to-end on a scratch directory.
- README has a demo GIF.
- Repo description, topics, and homepage set on GitHub.
- `CHANGELOG.md` has a `## v0.2.0` entry.
