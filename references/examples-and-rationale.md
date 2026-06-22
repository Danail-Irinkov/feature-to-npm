# Examples and rationale

These are the patterns this skill was designed around.

## Skill structure

A Codex skill is a directory containing a `SKILL.md` file and may include optional `scripts/`, `references/`, `assets/`, and `agents/` folders. `SKILL.md` needs frontmatter with `name` and `description`.

Codex scans repository-level skills under `.agents/skills` and user-level skills under `$HOME/.agents/skills`. For team use, put this folder at:

```text
<repo>/.agents/skills/feature-to-npm/
```

## npm package publishing basics

For public scoped packages, npm’s docs say to create a package with a scope, include a README, remove sensitive/unnecessary material, test the local package, and publish with public access.

Key checks before publish:

```bash
npm view @scope/package-name name
npm pack --dry-run
npm publish --access public
```

## Trusted Publishing and provenance

Preferred publishing setup is npm Trusted Publishing via OIDC, not long-lived npm tokens. The workflow needs `id-token: write`, a supported hosted CI runner, and an npm trusted publisher configured for the exact GitHub org/repo/workflow filename.

## Library build stack

Older examples often used `tsup`. The `tsup` repository now warns that it is not actively maintained and recommends `tsdown` instead. This skill defaults to `tsdown`, which is built for libraries, generates declarations, supports ESM/CJS output, and has starter templates.

Use Rollup/Vite library mode only when the feature requires complex plugin behavior or the source repo already depends heavily on those tools.

## Release automation examples

- `tsdown` starter templates: useful for clean TypeScript, React, and Vue libraries.
- TypeScript npm package templates often include `src/`, tests, package metadata, CI, README, LICENSE, SECURITY, and Changesets.
- Changesets’ GitHub action creates version/changelog PRs and can publish; token-based examples are common, but prefer Trusted Publishing where possible.

## Useful official docs to check when applying this skill

- OpenAI Codex Agent Skills docs.
- npm docs for `package.json`, scoped public packages, Trusted Publishing, and provenance.
- GitHub Actions docs for publishing Node.js packages.
- tsdown docs for package exports, declaration files, and validation.
- Changesets docs if automated version PRs are needed.
