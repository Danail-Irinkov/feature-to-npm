import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
])

const RESOLVE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.css', '.scss', '.sass', '.less',
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.wasm',
]

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

export function toPosix(value) {
  return value.split(path.sep).join('/')
}

export function fromPosix(value) {
  return value.split('/').join(path.sep)
}

export function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath))
}

export function stripCodeExtension(specifier) {
  const ext = path.posix.extname(specifier)
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return specifier.slice(0, -ext.length)
  }
  return specifier
}

export function normalizeRelativeSpecifier(fromRel, toRel) {
  let next = path.posix.relative(path.posix.dirname(fromRel), toRel)
  if (!next.startsWith('.')) next = `./${next}`
  next = stripCodeExtension(next)
  return next
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function dirExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function resolveFile(candidate) {
  if (fileExists(candidate)) return candidate

  const ext = path.extname(candidate)
  if (!ext) {
    for (const suffix of RESOLVE_EXTENSIONS) {
      const withExt = `${candidate}${suffix}`
      if (fileExists(withExt)) return withExt
    }
  }

  if (dirExists(candidate)) {
    for (const suffix of RESOLVE_EXTENSIONS) {
      const indexFile = path.join(candidate, `index${suffix}`)
      if (fileExists(indexFile)) return indexFile
    }
  }

  return null
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function readTsconfigInfo(repoAbs) {
  const candidates = [
    'tsconfig.json',
    'tsconfig.base.json',
    'jsconfig.json',
  ].map((name) => path.join(repoAbs, name))

  const configs = candidates
    .filter((filePath) => fileExists(filePath))
    .map((filePath) => ({ filePath, json: readJsonSafe(filePath) }))
    .filter((item) => item.json)

  const paths = []
  let baseUrlAbs = repoAbs

  for (const { filePath, json } of configs) {
    const compilerOptions = json.compilerOptions || {}
    const configDir = path.dirname(filePath)
    if (typeof compilerOptions.baseUrl === 'string') {
      baseUrlAbs = path.resolve(configDir, compilerOptions.baseUrl)
    }

    if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets)) continue
        for (const target of targets) {
          if (typeof target !== 'string') continue
          paths.push({ pattern, target, configDir, baseUrlAbs })
        }
      }
    }
  }

  return { baseUrlAbs, paths }
}

function matchPathPattern(pattern, specifier) {
  if (!pattern.includes('*')) {
    return pattern === specifier ? '' : null
  }

  const [prefix, suffix] = pattern.split('*')
  if (!specifier.startsWith(prefix)) return null
  if (suffix && !specifier.endsWith(suffix)) return null
  return specifier.slice(prefix.length, suffix ? -suffix.length : undefined)
}

function applyPathTarget(target, matched) {
  return target.includes('*') ? target.replace('*', matched) : target
}

export function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('node:')) return specifier
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : specifier
  }
  return specifier.split('/')[0]
}

// A real static import/require specifier never contains whitespace, a backtick,
// or `${}` interpolation. Regex scanning can otherwise pick up import/export
// statements embedded inside string or template literals — common in code that
// generates code — which are not real dependencies and would pollute the
// extracted package.json (an interpolated name even breaks `npm install`).
export function isStaticSpecifier(specifier) {
  return Boolean(specifier) && !/[`\s]|\$\{/.test(specifier)
}

// Characters after which a `/` begins a regex literal rather than a division. Consulted by
// the scanner so a quote inside a regex (e.g. /['"]/) is not mistaken for a string opener,
// which could otherwise swallow a following import. Sound for valid JS in expression
// position; a regex after a bare keyword (return/typeof/case/...) or `}` falls back to being
// read as division (a documented best-effort limitation — see scanCode).
const REGEX_OK_BEFORE = new Set([
  '(', ',', ';', '{', '[', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>',
])

function canPrecedeRegex(lastCode) {
  return lastCode === '' || REGEX_OK_BEFORE.has(lastCode)
}

// Given content[start] === '/', try to match a full single-line /.../flags regex literal,
// honouring \ escapes and [...] character classes. Returns the index just past the literal,
// or -1 when it is not a single-line regex (the caller then treats `/` as division). A raw
// newline aborts the match, since a regex literal cannot span lines.
function matchRegexLiteral(content, start) {
  let inClass = false
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\n') return -1
    if (ch === '\\') { i++; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      let j = i + 1
      while (j < content.length && /[a-z]/i.test(content[j])) j++
      return j
    }
  }
  return -1
}

// Single-pass scanner: removes `//` line and `/* */` block comments while respecting
// single/double-quoted strings, template literals, regex literals, and backslash escapes.
// Returns the comment-free text plus the [start, end) ranges (in that text) that fall inside
// string/template literals, so callers can tell a real import (keyword in code) from
// import-looking text that merely sits inside a string literal.
// Best-effort and dependency-free (no full JS parser); residual limitations: a template
// `${...}` interpolation is treated as opaque string content (a require/import nested inside
// one is not traced), and a regex literal after a bare keyword may be read as division.
function scanCode(content) {
  let out = ''
  const stringRanges = []
  let state = 'normal' // normal | single | double | template | line | block
  let stringStart = -1
  let lastCode = '' // last non-whitespace char emitted in code, for regex-vs-division
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (state === 'normal') {
      if (ch === '/' && next === '/') { state = 'line'; i++; continue }
      if (ch === '/' && next === '*') { state = 'block'; i++; continue }
      if (ch === '/' && canPrecedeRegex(lastCode)) {
        const end = matchRegexLiteral(content, i)
        if (end !== -1) {
          out += content.slice(i, end)
          lastCode = '/'
          i = end - 1
          continue
        }
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template'
        stringStart = out.length
        out += ch
        continue
      }
      out += ch
      if (!/\s/.test(ch)) lastCode = ch
      continue
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch
      if (ch === '\\') {
        if (i + 1 < content.length) { out += content[i + 1]; i++ }
        continue
      }
      const closed =
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      if (closed) {
        stringRanges.push([stringStart, out.length])
        state = 'normal'
        stringStart = -1
        lastCode = ch
      }
      continue
    }

    if (state === 'line') {
      if (ch === '\n') { state = 'normal'; out += ch }
      continue
    }

    // state === 'block'
    if (ch === '*' && next === '/') { state = 'normal'; i++; out += ' ' }
  }

  if (stringStart !== -1) stringRanges.push([stringStart, out.length])
  return { code: out, stringRanges }
}

// Removes comments while leaving string/template contents intact. Exposed for reuse/tests;
// extractModuleSpecifiers uses the richer scanCode directly to also get string ranges.
export function stripComments(content) {
  return scanCode(content).code
}

function indexInsideString(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true
  }
  return false
}

export function extractModuleSpecifiers(content) {
  // Scan once: strip comments (so commented-out imports vanish) and record string ranges (so
  // a real import is told apart from import-looking text sitting inside a string literal).
  const { code, stringRanges } = scanCode(content)
  const specs = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";()]+?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bexport\s+(?:type\s+)?[^'";()]+?\s+from\s*['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
  ]

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      // Drop import-looking text whose keyword sits inside a string literal (e.g. code that
      // generates code, like `const s = "import x from 'ghost'"`). A real import/require/
      // export keyword lives in code, so its match never starts inside a string range.
      if (indexInsideString(match.index, stringRanges)) continue
      specs.push(match[1])
    }
  }

  // isStaticSpecifier still drops `${}`/backtick/whitespace noise as a final guard.
  return [...new Set(specs)].filter(isStaticSpecifier)
}

// Rewrites import/require/export-from specifiers in place via `replacer`. This runs on the
// ORIGINAL content (comments and strings included) so the file is preserved verbatim except
// for remapped specifiers. Rewrites are gated by `replacer`, which returns the specifier
// unchanged (or a falsy value) for anything it does not remap. Callers build it from the
// extracted edge map, which — now that extraction ignores commented and string-literal
// imports — never contains those specifiers, so any import-looking text in a comment or
// string is left untouched. Real code specifiers are rewritten exactly as before.
export function rewriteModuleSpecifiers(content, replacer) {
  const patterns = [
    /(\bimport\s+(?:type\s+)?(?:[^'";()]+?\s+from\s*)?)(['"])([^'"]+)(\2)/gs,
    /(\bexport\s+(?:type\s+)?[^'";()]+?\s+from\s*)(['"])([^'"]+)(\2)/gs,
    /(\bimport\s*\(\s*)(['"])([^'"]+)(\2)/gs,
    /(\brequire\s*\(\s*)(['"])([^'"]+)(\2)/gs,
  ]

  let next = content
  for (const pattern of patterns) {
    next = next.replace(pattern, (match, prefix, quote, specifier, endQuote) => {
      const replacement = replacer(specifier)
      if (!replacement || replacement === specifier) return match
      return `${prefix}${quote}${replacement}${endQuote}`
    })
  }
  return next
}

function readImportsMap(repoAbs) {
  const json = readJsonSafe(path.join(repoAbs, 'package.json'))
  return json && json.imports && typeof json.imports === 'object' ? json.imports : null
}

// A Node "imports" target may be a string or a conditional object
// ({ import, require, node, default, ... }). Pick the first usable string target.
function pickConditionalTarget(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['import', 'node', 'default', 'require']) {
      if (typeof value[key] === 'string') return value[key]
    }
    for (const nested of Object.values(value)) {
      const found = pickConditionalTarget(nested)
      if (found) return found
    }
  }
  return null
}

// Resolve a `#name` subpath import against a package.json "imports" map, supporting exact
// keys and `*` wildcard patterns (reusing the tsconfig path matchers). Returns the mapped
// target string (repo-relative when it points at a file) or null.
function resolveImportsTarget(importsMap, specifier) {
  if (!importsMap) return null
  if (Object.prototype.hasOwnProperty.call(importsMap, specifier)) {
    return pickConditionalTarget(importsMap[specifier])
  }
  for (const [pattern, value] of Object.entries(importsMap)) {
    if (!pattern.includes('*')) continue
    const matched = matchPathPattern(pattern, specifier)
    if (matched === null) continue
    const target = pickConditionalTarget(value)
    if (target) return applyPathTarget(target, matched)
  }
  return null
}

export function resolveSpecifier({ repoAbs, fromFileAbs, specifier, tsconfigInfo, importsMap }) {
  if (!specifier || specifier.startsWith('http:') || specifier.startsWith('https:')) {
    return { kind: 'external', packageName: specifier }
  }

  // Node subpath imports ("#name") are repo-internal aliases resolved via package.json
  // "imports" — never public packages. Map to a local file when the target exists inside the
  // repo; otherwise 'unresolved' (never 'external', so a `#` alias cannot pollute deps even
  // if it maps to a bare package name). importsMap is read once by traceImportGraph; fall
  // back to reading it here so direct resolveSpecifier callers still work.
  if (specifier.startsWith('#')) {
    const target = resolveImportsTarget(importsMap || readImportsMap(repoAbs), specifier)
    if (target) {
      const candidate = path.resolve(repoAbs, target)
      const resolved = resolveFile(candidate)
      if (resolved && isInside(repoAbs, resolved)) {
        return { kind: 'local', fileAbs: resolved, fileRel: toPosix(path.relative(repoAbs, resolved)) }
      }
    }
    return { kind: 'unresolved' }
  }

  if (BUILTINS.has(specifier) || BUILTINS.has(packageNameFromSpecifier(specifier))) {
    return { kind: 'builtin', packageName: packageNameFromSpecifier(specifier) }
  }

  if (specifier.startsWith('.')) {
    const candidate = path.resolve(path.dirname(fromFileAbs), specifier)
    const resolved = resolveFile(candidate)
    if (resolved && isInside(repoAbs, resolved)) {
      return { kind: 'local', fileAbs: resolved, fileRel: toPosix(path.relative(repoAbs, resolved)) }
    }
    return { kind: 'unresolved' }
  }

  for (const item of tsconfigInfo.paths) {
    const matched = matchPathPattern(item.pattern, specifier)
    if (matched === null) continue
    const mapped = applyPathTarget(item.target, matched)
    const candidate = path.resolve(item.baseUrlAbs || item.configDir, mapped)
    const resolved = resolveFile(candidate)
    if (resolved && isInside(repoAbs, resolved)) {
      return { kind: 'local', fileAbs: resolved, fileRel: toPosix(path.relative(repoAbs, resolved)) }
    }
  }

  if (tsconfigInfo.baseUrlAbs) {
    const candidate = path.resolve(tsconfigInfo.baseUrlAbs, specifier)
    const resolved = resolveFile(candidate)
    if (resolved && isInside(repoAbs, resolved)) {
      return { kind: 'local', fileAbs: resolved, fileRel: toPosix(path.relative(repoAbs, resolved)) }
    }
  }

  return { kind: 'external', packageName: packageNameFromSpecifier(specifier) }
}

function shouldSkipRel(rel) {
  const parts = toPosix(rel).split('/')
  return parts.includes('node_modules') || parts.includes('.git') || parts.includes('dist') || parts.includes('build')
}

export function traceImportGraph({ repo, entries }) {
  const repoAbs = path.resolve(repo)
  const tsconfigInfo = readTsconfigInfo(repoAbs)
  const importsMap = readImportsMap(repoAbs)
  const queue = []
  const visited = new Set()
  const files = new Set()
  const edges = []
  const externalDependencies = new Set()
  const unresolved = []

  for (const entry of entries) {
    const entryAbs = path.isAbsolute(entry) ? entry : path.resolve(repoAbs, entry)
    const resolvedEntry = resolveFile(entryAbs)
    if (!resolvedEntry) {
      unresolved.push({ from: null, specifier: entry, reason: 'entry-not-found' })
      continue
    }
    queue.push(resolvedEntry)
  }

  while (queue.length) {
    const fileAbs = queue.shift()
    const fileRel = toPosix(path.relative(repoAbs, fileAbs))
    if (visited.has(fileRel) || shouldSkipRel(fileRel)) continue
    visited.add(fileRel)
    files.add(fileRel)

    if (!isCodeFile(fileAbs)) continue

    let content = ''
    try {
      content = fs.readFileSync(fileAbs, 'utf8')
    } catch (error) {
      unresolved.push({ from: fileRel, specifier: fileRel, reason: `read-failed: ${error.message}` })
      continue
    }

    for (const specifier of extractModuleSpecifiers(content)) {
      const resolved = resolveSpecifier({ repoAbs, fromFileAbs: fileAbs, specifier, tsconfigInfo, importsMap })
      if (resolved.kind === 'local') {
        edges.push({ from: fileRel, specifier, resolved: resolved.fileRel, kind: 'local' })
        if (!visited.has(resolved.fileRel)) queue.push(resolved.fileAbs)
      } else if (resolved.kind === 'external') {
        if (resolved.packageName) externalDependencies.add(resolved.packageName)
        edges.push({ from: fileRel, specifier, packageName: resolved.packageName, kind: 'external' })
      } else if (resolved.kind === 'builtin') {
        edges.push({ from: fileRel, specifier, packageName: resolved.packageName, kind: 'builtin' })
      } else {
        unresolved.push({ from: fileRel, specifier, reason: 'not-resolved' })
        edges.push({ from: fileRel, specifier, kind: 'unresolved' })
      }
    }
  }

  return {
    sourceRepo: repoAbs,
    entries: entries.map((entry) => toPosix(path.relative(repoAbs, path.isAbsolute(entry) ? entry : path.resolve(repoAbs, entry)))),
    files: [...files].sort().map((rel) => ({ from: rel, to: rel })),
    externalDependencies: [...externalDependencies].sort().filter((name) => !BUILTINS.has(name)),
    unresolved,
    edges: edges.sort((a, b) => `${a.from}:${a.specifier}`.localeCompare(`${b.from}:${b.specifier}`)),
  }
}
