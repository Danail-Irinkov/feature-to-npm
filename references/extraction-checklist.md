# Extraction checklist

## Source review

- [ ] Confirm source repo license and user’s right to open source the feature.
- [ ] Check `git status --short`; avoid mixing unrelated work into extraction.
- [ ] Identify package manager and lockfile.
- [ ] Identify module format, TypeScript config, path aliases, and framework.
- [ ] Identify feature entry file(s).
- [ ] Trace static imports and list external dependencies.
- [ ] Manually inspect dynamic imports, assets, CSS, generated files, and framework config.

## Code isolation

- [ ] Copy only the dependency closure needed by the feature.
- [ ] Rewrite app aliases to package-local paths.
- [ ] Replace app globals/env reads with options or adapter interfaces.
- [ ] Remove private endpoints, internal project names, customer data, analytics keys, and screenshots.
- [ ] Convert app tests/fixtures into library tests.
- [ ] Keep framework packages as peer dependencies.
- [ ] Export a small public API from `src/index.ts`.

## Package metadata

- [ ] Unique package name checked with `npm view`.
- [ ] `package.json` has `name`, `version`, `description`, `license`, `repository`, `exports`, `types`, and `files`.
- [ ] `publishConfig.access` is `public` for scoped public packages.
- [ ] README includes install and real usage.
- [ ] LICENSE, CHANGELOG, CONTRIBUTING, SECURITY exist.
- [ ] `repository` matches the public GitHub repo exactly before provenance publishing.

## Validation

- [ ] `npm install` works from a clean clone.
- [ ] `npm run build` succeeds.
- [ ] `npm test` succeeds.
- [ ] `npm run typecheck` succeeds.
- [ ] `npm run pack:dry` contains only intended files.
- [ ] `publint` and `@arethetypeswrong/cli` pass or warnings are explained.
- [ ] Packed tarball installs in a throwaway consumer project.

## Release

- [ ] GitHub repo is public.
- [ ] npm account/org exists.
- [ ] npm Trusted Publisher points to exact GitHub org/repo/workflow filename.
- [ ] GitHub release triggers publish workflow.
- [ ] Package page and README render correctly after publish.
