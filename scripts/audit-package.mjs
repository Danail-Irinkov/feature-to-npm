#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/ },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'generic-secret-assignment', pattern: /(?:secret|token|password|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i },
]

const SUSPICIOUS_FILENAMES = [
  /^\.env(?:\.|$)/,
  /\.pem$/,
  /\.key$/,
  /id_rsa$/,
  /id_dsa$/,
  /credentials/i,
  /service-account/i,
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--package-dir') args.packageDir = argv[++i]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

function usage() {
  console.log(`Usage:
  node scripts/audit-package.mjs --package-dir <new-package-dir>
`)
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function walk(dir, root = dir, output = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue
    const fullPath = path.join(dir, name)
    const rel = path.relative(root, fullPath)
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) walk(fullPath, root, output)
    else output.push(rel)
  }
  return output
}

function isProbablyText(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tgz', '.woff', '.woff2'].includes(ext)
}

function auditPackage(pkgDir) {
  const findings = []
  const warnings = []
  const pkgPath = path.join(pkgDir, 'package.json')
  const pkg = readJsonSafe(pkgPath)

  if (!pkg) {
    findings.push({ severity: 'error', message: 'Missing or invalid package.json' })
  } else {
    for (const field of ['name', 'version', 'description', 'license', 'type', 'exports', 'files']) {
      if (!pkg[field] || (Array.isArray(pkg[field]) && !pkg[field].length)) {
        findings.push({ severity: 'error', message: `package.json missing required field: ${field}` })
      }
    }

    if (!pkg.repository) warnings.push({ severity: 'warn', message: 'package.json has no repository; set it before provenance publishing.' })
    if (pkg.name?.startsWith('@') && pkg.publishConfig?.access !== 'public') {
      findings.push({ severity: 'error', message: 'Scoped public packages should set publishConfig.access to public.' })
    }
    if (!pkg.exports?.['.']) warnings.push({ severity: 'warn', message: 'package.json exports does not define the root export ".".' })
    if (pkg.dependencies?.react || pkg.dependencies?.['react-dom']) {
      warnings.push({ severity: 'warn', message: 'React is in dependencies; it usually belongs in peerDependencies.' })
    }
  }

  for (const required of ['README.md', 'LICENSE', 'CHANGELOG.md', 'src/index.ts', 'tsdown.config.ts', 'tsconfig.json']) {
    if (!fs.existsSync(path.join(pkgDir, required))) {
      findings.push({ severity: 'error', message: `Missing expected file: ${required}` })
    }
  }

  const files = fs.existsSync(pkgDir) ? walk(pkgDir) : []
  for (const rel of files) {
    const base = path.basename(rel)
    if (SUSPICIOUS_FILENAMES.some((pattern) => pattern.test(base) || pattern.test(rel))) {
      findings.push({ severity: 'error', file: rel, message: 'Suspicious file name; do not publish secrets or credentials.' })
    }

    const fullPath = path.join(pkgDir, rel)
    if (!isProbablyText(fullPath)) continue
    let content = ''
    try {
      content = fs.readFileSync(fullPath, 'utf8')
    } catch {
      continue
    }

    for (const item of SECRET_PATTERNS) {
      if (item.pattern.test(content)) {
        findings.push({ severity: 'error', file: rel, message: `Potential secret detected: ${item.name}` })
      }
    }

    if (/TODO_REPOSITORY_URL|CHANGE_ME|TODO: Author/.test(content)) {
      warnings.push({ severity: 'warn', file: rel, message: 'Placeholder text remains.' })
    }
  }

  return { findings, warnings }
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }
  if (!args.packageDir) throw new Error('Missing --package-dir')

  const packageDir = path.resolve(args.packageDir)
  const result = auditPackage(packageDir)
  console.log(JSON.stringify({ packageDir, ...result }, null, 2))

  if (result.findings.some((finding) => finding.severity === 'error')) {
    process.exit(2)
  }
} catch (error) {
  console.error(`audit-package failed: ${error.message}`)
  usage()
  process.exit(1)
}
