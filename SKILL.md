---
name: feature-to-npm
description: >-
  Use when someone wants to share a piece of their existing JavaScript/TypeScript work
  with the world as a proper open-source npm package and public GitHub repo — lifting a
  feature, component, hook, or utility out of a larger repo and turning it into a clean,
  MIT-by-default, installable library with tests, docs, CI, and a publish workflow, in
  roughly one shot. Triggers on "extract this into an npm package", "open-source this
  utility", "turn this hook/component into a library", "publish this as a package",
  "share this with the world as MIT", "make a public repo out of this feature". Skip when
  the user wants to open-source a whole repo as-is without packaging (just push it), the
  code isn't JS/TS, or they only want to run a build/test without extracting or publishing.
---

# feature-to-npm

You made something useful. This skill helps you give it to the world — properly — even if
you've never published an npm package or set up CI in your life.

Plenty of generous developers have a handy hook, component, or utility sitting inside a
bigger project that others would love to use. It rarely gets shared — not because people
are stingy, but because packaging it cleanly is a day of yak-shaving they don't have time
for. This skill collapses that into close to one shot: it lifts the minimal slice of code
out, wraps it in a clean MIT-by-default package with tests, docs, and a safe publish path,
checks it for secrets and hidden app coupling, and opens the public repo for you. Openness,
made low-effort — and done responsibly, so you never leak a secret or publish code you
don't own.

Use this skill when the user wants to take part of an existing JS/TS repo and turn it into
a standalone open-source npm library and public GitHub repository.

## Expected inputs

Proceed with reasonable defaults when any input is missing, but record assumptions in the
final summary. The whole point is to need as little from the user as possible.

- Source repo path or URL.
- Feature name and one or more entry files, for example `src/features/search/index.ts`.
- Target package name, preferably scoped, for example `@scope/search-core`.
- Target directory for the new package repo.
- License choice. Default to `MIT` (the most permissive, friendliest default for sharing)
  only when the user owns the code or the source license permits it.
- Intended runtime: browser, Node, React, Next, Vue, CLI, or framework-agnostic.

## Non-negotiables

Openness is only good when it's responsible. These guardrails are what make one-shot
sharing safe:

- Do not publish or prepare publication of code the user does not have the right to open source.
- Do not copy secrets, internal URLs, customer data, private configs, `.env` files, credentials, screenshots with sensitive data, or proprietary assets.
- Do not transplant the whole app. Extract the minimal dependency closure needed for the feature.
- Prefer dependency injection over hidden app globals, singleton clients, process env reads, or framework-specific assumptions.
- Keep framework packages such as `react`, `react-dom`, `vue`, `svelte`, `solid-js`, and `next` as peer dependencies unless the library truly owns them.
- Ensure package consumers can import from the public root, for example `import { feature } from '@scope/package'`.

## Default stack

Default to a TypeScript package using:

- `tsdown` for library bundling.
- `vitest` for tests.
- `publint` and `@arethetypeswrong/cli` for package/type validation.
- GitHub Actions CI.
- npm Trusted Publishing / OIDC for releases, avoiding long-lived npm tokens where possible.

Use another stack only if the source repo already strongly implies it.

## Locating this skill's scripts

The helper scripts live in this skill's own `scripts/` folder. Because the skill can be
installed in different places, set `SKILL_DIR` to the directory that contains this
`SKILL.md` before running them — for example `.claude/skills/feature-to-npm`,
`~/.agents/skills/feature-to-npm`, or a local clone of the published repo:

```bash
SKILL_DIR=path/to/feature-to-npm   # the folder holding this SKILL.md
```

The scripts are dependency-free Node (>=18) and expect the source repo as the working
directory.

## Pre-flight: confirm the feature is extractable

Extraction assumes a clean, decoupled feature. Before scaffolding anything, audit the
feature in place so you are lifting clean code, not app-entangled code. This step is
read-only — it changes nothing.

Trace the closure (the same tracer as step 3) and scan the source:

```bash
node "$SKILL_DIR/scripts/trace-imports.mjs" --repo . \
  --entry src/path/to/feature.ts --out extraction-manifest.json

node "$SKILL_DIR/scripts/audit-source.mjs" --repo . \
  --manifest extraction-manifest.json > extraction-audit.json
```

`audit-source.mjs` is a deterministic backbone — **necessary but not sufficient**. It is
heuristic (it can over-report a test-only `process.env` read, or miss an app singleton
imported under an unusual name), so read the flagged files and confirm with your own
judgment. It returns one verdict:

- `EXTRACTABLE` — go straight through the workflow below.
- `NEEDS-PREP` — fixable coupling/framework/API problems; the "Remove app coupling" phase
  below resolves them (confirming the serious calls with the user) before you package.
- `BLOCKED` — stop. The one problem refactoring cannot fix is the right to open-source
  (proprietary / no license / third-party code in the closure). Surface it and do not extract.

It flags, by severity and location: ownership/license, secrets and private data inside the
closure, app coupling (path aliases, `process.env` reads, app stores/services/loggers),
framework entanglement (`react`/`vue`/… that belong in peer dependencies), closure health,
and missing tests. Each item is tagged a **serious fork** (a design decision to confirm with
the user) or a mechanical fix.

## Workflow

### 1. Inspect the source repo

From the source repo, get oriented:

- Check `git status --short` so you don't mix unrelated work into the extraction.
- Read `package.json` and the lockfile to identify the package manager and module format.
- Read any `tsconfig*.json`, `vite.config.*`, or `next.config.*` (repo root and one or two
  levels down) to learn TypeScript settings, path aliases, the test runner, and the
  current license.

### 2. Define the public API

Identify the smallest entry file(s) that represent the feature. If the user only gives a
feature name, search for likely files (any search tool works), for example:

```bash
rg "FeatureName|featureName|export .*Feature|useFeature|createFeature" src packages apps
```

Choose a clean public API before copying code. The public API should normally be exported
from `src/index.ts` in the new package.

### 3. Trace and copy the dependency closure

Use the helper scripts (see "Locating this skill's scripts"):

```bash
node "$SKILL_DIR/scripts/trace-imports.mjs" \
  --repo . \
  --entry src/path/to/feature.ts \
  --out extraction-manifest.json

node "$SKILL_DIR/scripts/extract-feature.mjs" \
  --source . \
  --target ../new-package \
  --package @scope/package-name \
  --description "Reusable description" \
  --entry src/path/to/feature.ts
```

The tracer is intentionally simple (regex-based). If it misses dynamic imports, generated
files, CSS modules, assets, framework config, or non-TS files, add them manually and
document the additions. It can also over-report: import/export statements that live inside
string or template literals (e.g. code that generates code) may surface as dependencies, so
review the manifest's `externalDependencies` and drop anything that isn't a real import.

### 4. Remove app coupling (guided prepare)

Work from the pre-flight findings. Apply the mechanical fixes directly, but **do not silently
make the serious calls** — confirm each one with the user using the platform's built-in
multiple-choice prompt (in Claude Code, `AskUserQuestion`): 2-4 concrete options, a clear
recommendation, option labels phrased as noun phrases, then apply only what the user picks.

Mechanical (apply directly):

- Replace alias imports with relative imports or package-level imports.
- Remove dead imports the decoupling leaves behind.
- Convert source-only fixtures into package tests or examples.
- Keep internal helpers unexported unless they are part of the intended API.

Serious forks (confirm with a multiple-choice question first):

- **Dependency injection shape** — for something now read from a global/env: constructor
  option vs factory vs framework context/provider vs adapter interface.
- **Public API shape** — what to export from the root, named vs default, and the names
  consumers will see (renaming the public surface is a fork, not a cleanup).
- **Framework ownership** — keep the framework (`react`/`vue`/…) as a peer dependency, or
  split a framework-agnostic core from a thin framework adapter.
- **License** — `MIT` (friendliest default) vs `Apache-2.0` (patent grant) vs another,
  especially when third-party code is in the closure.
- **Extraction scope** — for a shared helper: bundle it into the package, inline a copy, or
  replace it with an existing npm dependency.
- **Secret / private-data handling** — remove it, replace with an injected option, or drop
  the file from the feature entirely.

When decoupling forces changes to the source app's own call sites (a value now passed in
rather than read from a global), tell the user and list every call site you touched. Then
re-run `audit-source.mjs` and continue only once it reports `EXTRACTABLE`.

### 5. Build package metadata

The package must have, at minimum:

- `name`, `version`, `description`, `license`.
- `type`, `main`, `module`, `types`, and `exports` consistent with emitted files.
- `files` allowlist so npm only publishes intended artifacts.
- `repository` matching the public GitHub repository before provenance publishing.
- `publishConfig.access = "public"` for scoped public packages.
- README with install, usage, API, and migration notes.
- LICENSE, CHANGELOG, CONTRIBUTING, and SECURITY files for open-source hygiene.

Check the name is free first: `npm view <name> name` (a 404 means it's available).

### 6. Validate locally

From the target package repo:

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint:pkg          # publint + @arethetypeswrong/cli
npm run pack:dry
node "$SKILL_DIR/scripts/audit-package.mjs" --package-dir .
```

The audit script scans for leaked secrets, credential-shaped filenames, and leftover
placeholders — treat any `error`-severity finding as a hard stop. Note that the generated
smoke test only checks that the API object exists; add a real assertion before you rely on
"tests pass" as proof.

Also test the packed tarball from a throwaway consumer project:

```bash
npm pack
mkdir /tmp/package-consumer && cd /tmp/package-consumer
npm init -y
npm install /path/to/package/*.tgz
node -e "import('@scope/package-name').then(console.log)"
```

For React/Vue/browser packages, add a tiny example app and verify it imports the built package.

### 7. Create the public GitHub repo

This is where the work reaches the world — so authenticate first, and fail loudly (never
silently) if you can't.

```bash
gh auth status     # if this fails, the user must run: gh auth login
npm whoami         # only needed if you will also publish to npm
```

When the package is ready **and** `gh` is authenticated:

```bash
cd ../new-package
git init -b main
git add .
git commit -m "Initial open-source extraction"
gh repo create OWNER/REPO --public --source . --remote origin --push
```

If `gh` is **not** authenticated, do everything up to and including the commit, then hand
the user the exact `gh auth login` and `gh repo create` commands to finish in one step.
Never abandon the publish quietly: either the repo is created, or you clearly report
"the repo is ready locally — authenticate and run X to publish it."

For scoped packages, `--access public` is required on first public publish unless it is
already set through `publishConfig` and the workflow respects it.

### 8. Release flow

Recommended release trigger:

1. Merge changes to `main`.
2. Create a GitHub Release.
3. Let `.github/workflows/publish.yml` build, test, and publish via npm Trusted Publishing.

Before the first release, configure the package's npm Trusted Publisher to reference the
exact GitHub org/repo/workflow filename, and make sure the `npm` GitHub Environment exists.
Use Changesets when the package will have frequent updates or multiple contributors. If you
must publish manually instead: `npm login && npm publish --access public`.

## Definition of done

The extraction is complete only when:

- The new repo builds from a fresh clone.
- Tests pass (with at least one meaningful assertion, not just the smoke test).
- `npm pack --dry-run` contains only intended files.
- A consumer can install the tarball and import the package.
- Package metadata points to the public repo.
- README includes installation and at least one real usage example.
- License and source-code ownership are clear.
- No secrets or private app details remain (audit script clean).

## Common failure modes

- **Alias imports break:** rewrite aliases to relative imports or configure package-local aliases.
- **Types are wrong for CJS/ESM:** run `publint` and `@arethetypeswrong/cli`; fix `exports` before publishing.
- **React bundled into output:** mark framework dependencies as peers and externals.
- **Feature secretly needs the app:** expose required dependencies as options, providers, or adapter interfaces.
- **Package publishes source junk:** use `files` in `package.json`, then inspect `npm pack --dry-run`.
- **Publish fails with auth error:** run `gh auth status` / `npm whoami`; for Trusted Publishing confirm the npm package settings reference the exact GitHub org/repo/workflow filename and that the workflow has `id-token: write`.

See `references/extraction-checklist.md` and `references/examples-and-rationale.md` for more detail.
