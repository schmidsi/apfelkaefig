# Plan: v0.1 release wrap-up

## Context

Step 1 of the release punch list landed in commit `912985e` (LICENSE, security section in README,
single-source version via `deno.json` JSON import, `templates/gitignore.block` fix). The SKILL.md
manual-setup guide landed in `d4d850f`. Everything below is what's left to get a clean v0.1 tag.

Do these roughly in order — each unblocks the next. Where order is optional, it's noted.

---

## 2. GitHub repo metadata

One-shot `gh` commands the user runs from macOS (no push needed):

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

- Social preview image (1280×640). Could be generated from the name + a small apple-in-cage glyph.
- Pinned issues for "known Apple `container` v0.9 bugs we work around" to pre-empt bug reports.

---

## 3. `akf doctor` + smoke test

### `akf doctor`

New subcommand. Checks:

1. Platform is `darwin-arm64`. Hard fail with a clear message otherwise.
2. `container --version` present and `>= 0.9.0`. Hard fail if missing; warn on unknown version.
3. `docker --version` present. Warn if missing (only needed for `build.sh`).
4. `~/.claude` exists and is readable. Warn (not fail) if missing — useful hint for first-time
   Claude users.

Wire into `init` as a soft preflight (current check is just `container --version`; expand it).

Files to create/touch:
- `src/commands/doctor.ts`
- `src/main.ts` — dispatch `doctor`
- `src/lib/preflight.ts` — shared by `init` and `doctor`

### Smoke test for `init`

Add a tmpdir-based integration test alongside `src/lib/fs_test.ts`:
- Point `runInit` at a fresh tmpdir, assert all six files land with the expected content.
- Re-run, assert every status is `skipped-*` and no mtimes change.
- Pre-populate `CLAUDE.md` with user content, run `init`, assert user content is preserved above
  the marker block.

Probably `src/commands/init_test.ts`.

---

## 4. CI (GitHub Actions)

Two workflows:

**`.github/workflows/ci.yml`** — on push/PR:
```
- deno fmt --check
- deno lint
- deno task check       # (new task: `deno check src/**/*.ts`)
- deno task test
- deno task compile     # smoke: ensure the binary builds
```
Run on `macos-14` (Apple Silicon) so the compiled binary matches what users will install.

**`.github/workflows/release.yml`** — on tag `v*`:
```
- deno task compile
- Upload dist/akf to the GitHub Release
- Publish to npm (see step 5)
```

Use `denoland/setup-deno@v2` to install Deno. Cache `~/.cache/deno`.

---

## 5. npm distribution

Single package `apfelkaefig` (Apple-Silicon-only, so we don't need the esbuild-style
multi-target optionalDependencies dance yet).

Shape:

```
npm/
├── package.json        # "bin": { "akf": "./bin/akf.mjs", "apfelkaefig": "./bin/akf.mjs" }
├── bin/akf.mjs         # Node shim: verify platform, exec the bundled binary
└── vendor/akf          # the macOS-arm64 binary (populated at release time)
```

`bin/akf.mjs` pseudocode:
```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("apfelkaefig requires macOS on Apple Silicon.");
  process.exit(1);
}
execFileSync(new URL("../vendor/akf", import.meta.url), process.argv.slice(2),
  { stdio: "inherit" });
```

Release workflow copies `dist/akf` into `npm/vendor/`, runs `npm publish` from `npm/` with
`NODE_AUTH_TOKEN`. Version in `npm/package.json` is bumped from `deno.json` via a small script.

Once published, the SKILL.md "try before you install" pitch gets a real shortcut: `npx apfelkaefig init`.

---

## 6. Demo tape (vhs)

Add `demo.tape` and `demo.gif` at repo root. Tape script rough shape:

```
Output demo.gif
Set FontSize 14
Set Width 1000
Set Height 600

Type "cd ~/code/my-project"
Enter
Type "akf init"
Enter
Sleep 2s
Type "./build.sh"
Enter
# ... abbreviated build output
Type "./start.sh"
Enter
Sleep 2s
Type "claude 'summarize this repo'"
Enter
Sleep 5s
```

Regenerate via `vhs demo.tape` — commit the `.tape` script; the `.gif` can be regenerated in CI on
tag and uploaded as a release asset + embedded in README.

Embed in README under the "Use" section.

---

## Smaller loose ends

- **`assets/chrome-bridge/` is currently dangling** — referenced from SKILL.md's "notes" but not
  shipped by `init`. Either wire it into v0.2 (Chrome CDP proxy), or drop the reference from SKILL.md
  until it's real.
- **`CHANGELOG.md`** — start one on the first tag. Even a one-entry `## v0.1.0` with a link to the
  GitHub Release notes is enough.
- **Minimum `container` version** — pick an exact floor (probably `0.9.0` since that's what we've
  tested), document in README requirements, enforce in `akf doctor`.
- **Verify the `deno.json` JSON import compiles into the binary.** Current state is untested (the
  container we develop in doesn't have `deno`). Run `deno task compile && ./dist/akf --version` on
  the host once. If the import breaks under `deno compile`, fall back to injecting the version at
  compile time via `--env` or a codegen step.
- **`tasks/` directory in the shipped scaffold?** The user's own projects don't need it, and the
  templates don't include it — just a note that `tasks/` is apfelkäfig-internal planning, not a
  scaffold artifact.

---

## Definition of done for v0.1

- `LICENSE` present ✅
- `deno.json` is single source of truth for version ✅
- `akf doctor` passes on a clean macOS Apple Silicon box with `container` + `docker` installed
- CI is green on `main`
- `git tag v0.1.0` triggers a release that uploads `akf` binary + publishes `apfelkaefig` to npm
- README has a demo GIF
- `npx apfelkaefig init` works end-to-end on a scratch directory
- Repo has description, topics, homepage set on GitHub
