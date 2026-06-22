#!/usr/bin/env node
// Source-feature extractability audit for feature-to-npm.
// Read-only: scans a feature's dependency closure for the problems that block a clean
// open-source extraction, then prints a structured verdict + findings. The verdict drives
// the guided prepare phase in SKILL.md ("Remove app coupling"). This script never edits.
//
// Closure source (pick one):
//   --manifest <file>  extraction-manifest.json from scripts/trace-imports.mjs
//                      (preferred: precise closure, follows imports out of the feature dir)
//   --dir <dir>        scan a directory recursively (fallback: misses cross-dir imports)
//
// Usage:
//   node audit-source.mjs --repo . --manifest extraction-manifest.json
//   node audit-source.mjs --repo . --dir src/features/search
import fs from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/ },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'generic-secret', pattern: /(?:secret|token|password|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i },
]

const SUSPICIOUS_FILENAMES = [
  /^\.env(?:\.|$)/, /\.pem$/, /\.key$/, /id_rsa$/, /id_dsa$/, /credentials/i, /service-account/i,
]

const FRAMEWORK_PACKAGES = new Set([
  'react', 'react-dom', 'vue', 'svelte', 'solid-js', 'next', 'nuxt', 'preact', '@angular/core',
])

const ENV_PATTERNS = [
  { name: 'process.env', pattern: /process\.env\.[A-Za-z0-9_]+/g },
  { name: 'import.meta.env', pattern: /import\.meta\.env\.[A-Za-z0-9_]+/g },
  { name: 'Deno.env', pattern: /Deno\.env\b/g },
]

// Common app-internal path-alias prefixes and subpath-import markers.
const ALIAS_PREFIXES = ['@/', '~/', '#']

// Path segments that usually mean "reaches into app infrastructure" rather than
// "self-contained feature code". Heuristic — the agent confirms each one.
const APP_SMELL_SEGMENTS = [
  '/stores/', '/store/', '/services/', '/service/', '/logger', '/analytics',
  '/sentry', '/firebase', '/supabase', '/config/', '/app-context', '/providers/',
]

const INTERNAL_URL = /https?:\/\/[^\s'"`]*(?:\.internal\b|localhost|127\.0\.0\.1|\.local\b)/i

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tgz', '.woff', '.woff2', '.wasm',
])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])

function parseArgs(argv) {
  const args = { repo: '.', entries: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--repo') args.repo = argv[++i]
    else if (token === '--manifest') args.manifest = argv[++i]
    else if (token === '--dir') args.dir = argv[++i]
    else if (token === '--entry') args.entries.push(argv[++i])
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

function usage() {
  console.log(`Usage:
  node audit-source.mjs --repo <source-repo> --manifest <extraction-manifest.json>
  node audit-source.mjs --repo <source-repo> --dir <feature-dir>
`)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function lineAt(content, index) {
  if (index < 0) return undefined
  let line = 1
  for (let i = 0; i < index && i < content.length; i += 1) if (content[i] === '\n') line += 1
  return line
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function importSpecifiers(content) {
  const specs = []
  const re =
    /(?:\bimport\b|\bexport\b)[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(content))) specs.push({ spec: m[1] || m[2] || m[3], index: m.index })
  return specs
}

function walkDir(dir, root, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) walkDir(full, root, out)
    else out.push(toPosix(path.relative(root, full)))
  }
  return out
}

function scanFile(rel, content, findings) {
  const add = (f) => findings.push({ file: rel, ...f })

  for (const item of SECRET_PATTERNS) {
    const m = item.pattern.exec(content)
    if (m) add({ severity: 'major', category: 'secret', fork: true, line: lineAt(content, m.index),
      detail: `Potential secret in source (${item.name}); decide remove vs inject before publishing.` })
  }

  for (const item of ENV_PATTERNS) {
    const names = [...new Set([...content.matchAll(item.pattern)].map((x) => x[0]))]
    if (names.length) add({ severity: 'major', category: 'coupling-env', fork: true,
      detail: `Reads environment directly (${names.slice(0, 6).join(', ')}); inject as options instead.` })
  }

  for (const { spec, index } of importSpecifiers(content)) {
    if (!spec) continue
    const pkg = packageNameOf(spec)
    if (FRAMEWORK_PACKAGES.has(pkg)) add({ severity: 'major', category: 'framework-peer', fork: true,
      line: lineAt(content, index), detail: `Imports framework package "${pkg}"; should be a peer dependency or kept out of the core.` })
    if (ALIAS_PREFIXES.some((p) => spec.startsWith(p))) add({ severity: 'major', category: 'coupling-alias', fork: false,
      line: lineAt(content, index), detail: `App path-alias import "${spec}"; rewrite to a relative or package import.` })
    if (APP_SMELL_SEGMENTS.some((seg) => `/${spec}`.includes(seg))) add({ severity: 'major', category: 'coupling-app', fork: true,
      line: lineAt(content, index), detail: `Imports app infrastructure "${spec}"; expose as an injected dependency.` })
  }

  const urlMatch = INTERNAL_URL.exec(content)
  if (urlMatch) add({ severity: 'minor', category: 'private-data', fork: false, line: lineAt(content, urlMatch.index),
    detail: `Internal/local URL in source ("${urlMatch[0].slice(0, 60)}"); remove or make configurable.` })
}

function audit({ repoAbs, files, externalDependencies, unresolved }) {
  const findings = []

  for (const rel of files) {
    const base = path.basename(rel)
    if (SUSPICIOUS_FILENAMES.some((p) => p.test(base) || p.test(rel))) {
      findings.push({ file: rel, severity: 'major', category: 'secret-file', fork: true,
        detail: 'Credential-shaped file in the closure; it must not be part of the package.' })
    }
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    let content = ''
    try {
      content = fs.readFileSync(path.join(repoAbs, rel), 'utf8')
    } catch {
      continue
    }
    scanFile(rel, content, findings)
  }

  // Ownership / license — the one finding refactoring cannot fix.
  const pkg = readJsonSafe(path.join(repoAbs, 'package.json'))
  const license = pkg && typeof pkg.license === 'string' ? pkg.license : null
  if (!license) {
    findings.push({ file: 'package.json', severity: 'blocker', category: 'ownership', fork: true,
      detail: 'Source has no declared license; confirm you have the right to open-source this before continuing.' })
  } else if (/^unlicensed$/i.test(license) || /proprietary/i.test(license)) {
    findings.push({ file: 'package.json', severity: 'blocker', category: 'ownership', fork: true,
      detail: `Source license is "${license}"; you cannot open-source this without explicit permission.` })
  }

  // Tests — not a blocker, but prep should add a real assertion.
  const hasTest = files.some((rel) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel))
  if (!hasTest) {
    findings.push({ file: '(closure)', severity: 'minor', category: 'tests', fork: false,
      detail: 'No colocated test in the closure; add at least one meaningful assertion during prep.' })
  }

  for (const item of unresolved || []) {
    findings.push({ file: item.from || '(entry)', severity: 'minor', category: 'closure', fork: false,
      detail: `Unresolved import "${item.specifier}" (${item.reason}); verify it is not hidden app coupling.` })
  }

  const has = (sev) => findings.some((f) => f.severity === sev)
  const verdict = has('blocker') ? 'BLOCKED' : has('major') ? 'NEEDS-PREP' : 'EXTRACTABLE'
  const counts = { blocker: 0, major: 0, minor: 0 }
  for (const f of findings) counts[f.severity] += 1

  return {
    repo: repoAbs,
    verdict,
    closureFileCount: files.length,
    externalDependencies: externalDependencies || [],
    counts,
    forks: findings.filter((f) => f.fork).length,
    findings: findings.sort((a, b) => {
      const order = { blocker: 0, major: 1, minor: 2 }
      return order[a.severity] - order[b.severity] || a.category.localeCompare(b.category)
    }),
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  const repoAbs = path.resolve(args.repo)
  let files = []
  let externalDependencies = []
  let unresolved = []

  if (args.manifest) {
    const manifest = readJsonSafe(path.resolve(args.manifest))
    if (!manifest || !Array.isArray(manifest.files)) throw new Error(`Could not read closure from ${args.manifest}`)
    files = manifest.files.map((f) => (typeof f === 'string' ? f : f.from || f.to)).filter(Boolean)
    externalDependencies = manifest.externalDependencies || []
    unresolved = manifest.unresolved || []
  } else if (args.dir) {
    const dirAbs = path.resolve(repoAbs, args.dir)
    files = walkDir(dirAbs, repoAbs)
    console.error('Note: --dir mode scans one directory and misses imports that reach outside it. Prefer --manifest.')
  } else {
    throw new Error('Provide --manifest <file> or --dir <feature-dir>')
  }

  const result = audit({ repoAbs, files, externalDependencies, unresolved })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.verdict === 'EXTRACTABLE' ? 0 : 2)
} catch (error) {
  console.error(`audit-source failed: ${error.message}`)
  usage()
  process.exit(1)
}
