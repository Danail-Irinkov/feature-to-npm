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

export function extractModuleSpecifiers(content) {
  const specs = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";()]+?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bexport\s+(?:type\s+)?[^'";()]+?\s+from\s*['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      specs.push(match[1])
    }
  }

  return [...new Set(specs)].filter(isStaticSpecifier)
}

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

export function resolveSpecifier({ repoAbs, fromFileAbs, specifier, tsconfigInfo }) {
  if (!specifier || specifier.startsWith('http:') || specifier.startsWith('https:')) {
    return { kind: 'external', packageName: specifier }
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
      const resolved = resolveSpecifier({ repoAbs, fromFileAbs: fileAbs, specifier, tsconfigInfo })
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
