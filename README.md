# feature-to-npm

**Share a piece of your work with the world — properly — in roughly one shot.**

`feature-to-npm` is an agent skill for [Claude Code](https://claude.com/claude-code) and
[OpenAI Codex](https://developers.openai.com/codex/). You point it at a feature inside an
existing JavaScript/TypeScript repo, and it lifts that feature out into a clean,
MIT-by-default, installable npm package with tests, docs, CI, and a safe publish path — and
opens the public GitHub repo for you.

## Why this exists

A lot of good, generous developers have a handy hook, component, or utility sitting inside
a bigger project that other people would genuinely benefit from. It rarely gets shared —
not because anyone is stingy, but because packaging it cleanly (licensing, `exports` maps,
dual ESM/CJS, type validation, CI, trusted publishing) is a day of yak-shaving most people
don't have time for.

This skill removes that tax. **Openness made low-effort** — so the work that deserves to be
out in the world actually gets there. Spreading the good.

And it does it responsibly: it refuses to copy secrets, internal URLs, customer data, or
code you don't have the right to open-source, and it audits the result before anything is
published.

## What it does

- **Traces the minimal dependency closure** of your feature (no transplanting the whole app).
- **Scaffolds a clean package**: `tsdown` build, dual ESM/CJS + types, `vitest`, `publint` +
  `@arethetypeswrong/cli`, README/LICENSE/CHANGELOG/CONTRIBUTING/SECURITY.
- **Audits for safety**: scans for leaked secrets, credential-shaped filenames, and hidden
  app coupling before you publish.
- **Sets up publishing the modern way**: GitHub Actions CI + npm Trusted Publishing (OIDC),
  so you don't need long-lived npm tokens.
- **Opens the public repo** with `gh` when your terminal is authenticated.

## Install

This repository *is* the skill (the `SKILL.md` at the root is the entry point). Drop it into
your agent's skills directory:

**Claude Code**

```bash
# project-level
git clone https://github.com/Danail-Irinkov/feature-to-npm .claude/skills/feature-to-npm
# or user-level (available in every project)
git clone https://github.com/Danail-Irinkov/feature-to-npm ~/.claude/skills/feature-to-npm
```

**OpenAI Codex**

```bash
# project-level
git clone https://github.com/Danail-Irinkov/feature-to-npm .agents/skills/feature-to-npm
# or user-level
git clone https://github.com/Danail-Irinkov/feature-to-npm ~/.agents/skills/feature-to-npm
```

## Use it

Open your agent in the repo that contains the feature, and just ask in plain language:

> "Extract `src/features/search` into an MIT npm package called `@me/search-core` and open
> a public repo for it."

> "Open-source this React hook as a standalone library."

The skill will ask for anything it needs, then drive the whole workflow — trace, scaffold,
de-couple, validate, audit, and publish.

## Requirements

- Node.js 18+ (the helper scripts are dependency-free).
- [`gh`](https://cli.github.com/) authenticated (`gh auth login`) to create the public repo.
- An npm account only if you also publish to npm.

## What's inside

```
SKILL.md                     the skill's instructions (the entry point)
scripts/                     dependency-free Node helpers
  trace-imports.mjs            trace a feature's import closure
  extract-feature.mjs          scaffold the new package from a manifest
  audit-package.mjs            secret / coupling / metadata audit
  lib/import-tracer.mjs        the tracer core
assets/templates/            package scaffolding (package.json, tsdown, CI, license, ...)
references/                  extraction checklist + rationale
agents/openai.yaml           Codex skill metadata
```

## Responsible openness

Sharing is only good when it's safe. This skill will not knowingly publish secrets, private
configuration, customer data, or code you don't own. The pre-publish audit is a hard gate,
not a suggestion. You are still the final reviewer — look at what it produced before you
hit publish.

## Contributing

PRs and ideas are welcome — see [CONTRIBUTING](assets/templates/CONTRIBUTING.md) for the
spirit of it. The goal is to make sharing good work as frictionless, and as safe, as
possible.

## License

[MIT](LICENSE) — use it, fork it, share it. That's the whole point.
