#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isCodeFile,
  normalizeRelativeSpecifier,
  rewriteModuleSpecifiers,
  traceImportGraph,
  toPosix,
} from './lib/import-tracer.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..')
const templatesDir = path.join(skillRoot, 'assets', 'templates')

const FRAMEWORK_PEERS = new Set([
  'react', 'react-dom', 'react-native',
  'vue', 'svelte', 'solid-js',
  'next', '@angular/core', '@angular/common',
  '@nestjs/common', '@nestjs/core',
])

function parseArgs(argv) {
  const args = { entries: [], license: 'MIT', force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--source') args.source = argv[++i]
    else if (token === '--target') args.target = argv[++i]
    else if (token === '--entry') args.entries.push(argv[++i])
    else if (token === '--manifest') args.manifest = argv[++i]
    else if (token === '--package') args.packageName = argv[++i]
    else if (token === '--description') args.description = argv[++i]
    else if (token === '--license') args.license = argv[++i]
    else if (token === '--author') args.author = argv[++i]
    else if (token === '--repo-url') args.repoUrl = argv[++i]
    else if (token === '--force') args.force = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

function usage() {
  console.log(`Usage:
  node scripts/extract-feature.mjs \
    --source <source-repo> \
    --target <new-package-dir> \
    --package <@scope/name-or-name> \
    --description <description> \
    --entry <file> [--entry <file>...] \
    [--repo-url https://github.com/owner/repo] \
    [--author "Name"] \
    [--license MIT] \
    [--manifest extraction-manifest.json] \
    [--force]

Example:
  node scripts/extract-feature.mjs --source . --target ../search-core --package @acme/search-core --description "Search feature primitives" --entry src/features/search/index.ts
`)
}

function assertPackageName(name) {
  if (!name) throw new Error('Missing --package')
  const ok = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(name)
  if (!ok) throw new Error(`Invalid npm package name: ${name}`)
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function copyTemplate(templateRel, targetRel, replacements = {}) {
  const src = path.join(templatesDir, templateRel)
  const dest = path.join(replacements.__targetAbs, targetRel)
  let content = fs.readFileSync(src, 'utf8')
  for (const [key, value] of Object.entries(replacements)) {
    if (key === '__targetAbs') continue
    content = content.replaceAll(`{{${key}}}`, value ?? '')
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, content)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureEmptyOrForce(targetAbs, force) {
  if (!fs.existsSync(targetAbs)) return
  const entries = fs.readdirSync(targetAbs).filter((name) => name !== '.DS_Store')
  if (entries.length && !force) {
    throw new Error(`Target directory is not empty: ${targetAbs}. Use --force to write into it.`)
  }
}

function inferVersion(sourcePkg, depName) {
  return sourcePkg.peerDependencies?.[depName]
    || sourcePkg.dependencies?.[depName]
    || sourcePkg.devDependencies?.[depName]
    || sourcePkg.optionalDependencies?.[depName]
    || '*'
}

function buildPackageJson({ packageName, description, license, author, repoUrl, externalDependencies, sourcePkg }) {
  const dependencies = {}
  const peerDependencies = {}
  const devDependencies = {
    '@arethetypeswrong/cli': 'latest',
    publint: 'latest',
    tsdown: 'latest',
    typescript: 'latest',
    vitest: 'latest',
  }

  for (const depName of externalDependencies) {
    if (!depName || depName.startsWith('node:')) continue
    const version = inferVersion(sourcePkg, depName)
    if (sourcePkg.peerDependencies?.[depName] || FRAMEWORK_PEERS.has(depName)) {
      peerDependencies[depName] = version
      devDependencies[depName] = version
    } else if (sourcePkg.optionalDependencies?.[depName]) {
      dependencies[depName] = version
    } else {
      dependencies[depName] = version
    }
  }

  const pkg = {
    name: packageName,
    version: '0.1.0',
    description: description || 'Reusable library extracted from an existing application feature.',
    type: 'module',
    sideEffects: false,
    main: './dist/index.cjs',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        require: './dist/index.cjs',
      },
    },
    files: ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md'],
    scripts: {
      build: 'tsdown',
      dev: 'tsdown --watch',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      'lint:pkg': 'publint && attw --pack .',
      'pack:dry': 'npm pack --dry-run',
      prepack: 'npm run build && npm test && npm run typecheck',
    },
    keywords: [],
    author: author || '',
    license,
    publishConfig: { access: 'public' },
    dependencies,
    peerDependencies,
    devDependencies,
  }

  if (repoUrl) {
    const cleanRepo = repoUrl.replace(/\.git$/, '')
    pkg.repository = { type: 'git', url: `git+${cleanRepo}.git` }
    pkg.bugs = { url: `${cleanRepo}/issues` }
    pkg.homepage = `${cleanRepo}#readme`
  }

  if (!Object.keys(pkg.dependencies).length) delete pkg.dependencies
  if (!Object.keys(pkg.peerDependencies).length) delete pkg.peerDependencies

  return pkg
}

function createEdgeMap(manifest) {
  const map = new Map()
  for (const edge of manifest.edges || []) {
    if (edge.kind !== 'local' || !edge.resolved) continue
    map.set(`${edge.from}\0${edge.specifier}`, edge.resolved)
  }
  return map
}

function copyFeatureFiles({ sourceAbs, targetAbs, manifest }) {
  const edgeMap = createEdgeMap(manifest)
  const copied = []

  for (const item of manifest.files || []) {
    const fromRel = item.from || item
    const toRel = item.to || fromRel
    const src = path.join(sourceAbs, fromRel.split('/').join(path.sep))
    const dest = path.join(targetAbs, toRel.split('/').join(path.sep))

    if (!fs.existsSync(src)) {
      console.warn(`Skipping missing file from manifest: ${fromRel}`)
      continue
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (isCodeFile(src)) {
      const original = fs.readFileSync(src, 'utf8')
      const rewritten = rewriteModuleSpecifiers(original, (specifier) => {
        const resolvedRel = edgeMap.get(`${fromRel}\0${specifier}`)
        if (!resolvedRel) return specifier
        return normalizeRelativeSpecifier(toRel, resolvedRel)
      })
      fs.writeFileSync(dest, rewritten)
    } else {
      fs.copyFileSync(src, dest)
    }
    copied.push(toRel)
  }

  return copied
}

function generatePublicIndex({ targetAbs, entries, copiedFiles }) {
  const indexRel = 'src/index.ts'
  const indexAbs = path.join(targetAbs, 'src', 'index.ts')

  const copiedSet = new Set(copiedFiles)
  const entrySet = new Set(entries)

  if (copiedSet.has(indexRel) && entrySet.has(indexRel)) {
    return { generated: false, reason: 'entry-already-src-index' }
  }

  if (fs.existsSync(indexAbs) && !entrySet.has(indexRel)) {
    return { generated: false, reason: 'src-index-exists' }
  }

  const exportLines = []
  for (const entry of entries) {
    if (entry === indexRel) continue
    exportLines.push(`export * from '${normalizeRelativeSpecifier(indexRel, entry)}'`)
  }

  if (!exportLines.length) {
    if (!fs.existsSync(indexAbs)) {
      fs.mkdirSync(path.dirname(indexAbs), { recursive: true })
      fs.writeFileSync(indexAbs, '// Export your public API here.\n')
      return { generated: true, reason: 'placeholder' }
    }
    return { generated: false, reason: 'no-extra-entries' }
  }

  fs.mkdirSync(path.dirname(indexAbs), { recursive: true })
  fs.writeFileSync(indexAbs, `${exportLines.join('\n')}\n`)
  return { generated: true, reason: 'exports-generated' }
}

function createSmokeTest(targetAbs, packageName) {
  const testPath = path.join(targetAbs, 'tests', 'smoke.test.ts')
  fs.mkdirSync(path.dirname(testPath), { recursive: true })
  fs.writeFileSync(testPath, `import { describe, expect, test } from 'vitest'\n\nimport * as api from '../src/index'\n\ndescribe('${packageName}', () => {\n  test('exports an API surface', () => {\n    expect(api).toBeDefined()\n  })\n})\n`)
}

function readManifestOrTrace(args, sourceAbs) {
  if (args.manifest) {
    const manifestPath = path.resolve(args.manifest)
    const manifest = readJsonSafe(manifestPath)
    if (!manifest) throw new Error(`Could not read manifest JSON: ${manifestPath}`)
    return manifest
  }
  if (!args.entries.length) throw new Error('Provide --entry or --manifest')
  return traceImportGraph({ repo: sourceAbs, entries: args.entries })
}

function normalizeEntries(manifest, sourceAbs) {
  const files = new Set((manifest.files || []).map((item) => item.to || item.from || item))
  return (manifest.entries || [])
    .map((entry) => {
      if (files.has(entry)) return entry
      const rel = toPosix(path.relative(sourceAbs, path.isAbsolute(entry) ? entry : path.resolve(sourceAbs, entry)))
      return files.has(rel) ? rel : entry
    })
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  if (!args.source) throw new Error('Missing --source')
  if (!args.target) throw new Error('Missing --target')
  assertPackageName(args.packageName)

  const sourceAbs = path.resolve(args.source)
  const targetAbs = path.resolve(args.target)
  ensureEmptyOrForce(targetAbs, args.force)
  fs.mkdirSync(targetAbs, { recursive: true })

  const manifest = readManifestOrTrace(args, sourceAbs)
  const sourcePkg = readJsonSafe(path.join(sourceAbs, 'package.json')) || {}
  const packageJson = buildPackageJson({
    packageName: args.packageName,
    description: args.description,
    license: args.license,
    author: args.author,
    repoUrl: args.repoUrl,
    externalDependencies: manifest.externalDependencies || [],
    sourcePkg,
  })

  const year = String(new Date().getFullYear())
  const replacements = {
    __targetAbs: targetAbs,
    PACKAGE_NAME: args.packageName,
    DESCRIPTION: packageJson.description,
    LICENSE: args.license,
    AUTHOR: args.author || packageJson.author || 'TODO: Author',
    YEAR: year,
  }

  const copiedFiles = copyFeatureFiles({ sourceAbs, targetAbs, manifest })

  copyTemplate('tsconfig.json', 'tsconfig.json', replacements)
  copyTemplate('tsdown.config.ts', 'tsdown.config.ts', replacements)
  copyTemplate('vitest.config.ts', 'vitest.config.ts', replacements)
  copyTemplate('.gitignore', '.gitignore', replacements)
  copyTemplate('.npmignore', '.npmignore', replacements)
  copyTemplate('.github/workflows/ci.yml', '.github/workflows/ci.yml', replacements)
  copyTemplate('.github/workflows/publish.yml', '.github/workflows/publish.yml', replacements)
  copyTemplate('.changeset/config.json', '.changeset/config.json', replacements)
  copyTemplate('README.md', 'README.md', replacements)
  copyTemplate('CHANGELOG.md', 'CHANGELOG.md', replacements)
  copyTemplate('CONTRIBUTING.md', 'CONTRIBUTING.md', replacements)
  copyTemplate('SECURITY.md', 'SECURITY.md', replacements)
  copyTemplate('LICENSE-MIT', 'LICENSE', replacements)

  writeJson(path.join(targetAbs, 'package.json'), packageJson)
  writeJson(path.join(targetAbs, 'extraction-manifest.json'), manifest)

  const entries = normalizeEntries(manifest, sourceAbs)
  const indexResult = generatePublicIndex({ targetAbs, entries, copiedFiles })
  createSmokeTest(targetAbs, args.packageName)

  const summary = {
    target: targetAbs,
    packageName: args.packageName,
    copiedFiles: copiedFiles.length,
    externalDependencies: manifest.externalDependencies || [],
    unresolved: manifest.unresolved || [],
    publicIndex: indexResult,
    nextSteps: [
      'Review copied code for app coupling and private data.',
      'Run npm install, npm run build, npm test, npm run typecheck, npm run pack:dry.',
      'Update README API docs and package repository metadata before publishing.',
      'Configure npm Trusted Publishing for .github/workflows/publish.yml.',
    ],
  }

  console.log(JSON.stringify(summary, null, 2))

  if ((manifest.unresolved || []).length) {
    console.warn('Warning: unresolved imports remain. Fix them before publishing.')
  }
} catch (error) {
  console.error(`extract-feature failed: ${error.message}`)
  usage()
  process.exit(1)
}
