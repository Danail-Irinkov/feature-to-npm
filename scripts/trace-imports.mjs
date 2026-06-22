#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { traceImportGraph } from './lib/import-tracer.mjs'

function parseArgs(argv) {
  const args = { entries: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--repo') args.repo = argv[++i]
    else if (token === '--entry') args.entries.push(argv[++i])
    else if (token === '--out') args.out = argv[++i]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

function usage() {
  console.log(`Usage:
  node scripts/trace-imports.mjs --repo <source-repo> --entry <file> [--entry <file>...] [--out extraction-manifest.json]

Example:
  node scripts/trace-imports.mjs --repo . --entry src/features/search/index.ts --out extraction-manifest.json
`)
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }
  if (!args.repo) throw new Error('Missing --repo')
  if (!args.entries.length) throw new Error('Provide at least one --entry')

  const manifest = traceImportGraph({ repo: args.repo, entries: args.entries })
  const output = `${JSON.stringify(manifest, null, 2)}\n`

  if (args.out) {
    const outPath = path.resolve(args.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, output)
    console.log(`Wrote ${outPath}`)
  } else {
    process.stdout.write(output)
  }

  if (manifest.unresolved.length) {
    console.error(`Warning: ${manifest.unresolved.length} unresolved import(s). Inspect the manifest before extracting.`)
  }
} catch (error) {
  console.error(`trace-imports failed: ${error.message}`)
  usage()
  process.exit(1)
}
