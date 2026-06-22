import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { extractModuleSpecifiers, traceImportGraph } from '../scripts/lib/import-tracer.mjs'

describe('extractModuleSpecifiers', () => {
  // The real import must survive; imports that only appear inside comments or
  // string literals are not dependencies and must be ignored. This guards the
  // comment/string-stripping behaviour of the extractor — if it ever
  // over-reports again, these assertions are the first to fail.
  test('keeps real imports but ignores commented and string-literal imports', () => {
    const content = [
      "// import lineCommented from 'line-comment-dep'",
      "/* import blockCommented from 'block-comment-dep' */",
      'const generated = "import inString from \'string-literal-dep\'"',
      "import realDefault from 'zod'",
      '',
    ].join('\n')

    const specifiers = extractModuleSpecifiers(content)

    expect(specifiers).toContain('zod')
    expect(specifiers).not.toContain('line-comment-dep')
    expect(specifiers).not.toContain('block-comment-dep')
    expect(specifiers).not.toContain('string-literal-dep')
  })
})

describe('traceImportGraph', () => {
  let fixtureDir

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2npm-trace-'))
    fs.writeFileSync(path.join(fixtureDir, 'util.mjs'), 'export const helper = () => 1\n')
    fs.writeFileSync(
      path.join(fixtureDir, 'entry.mjs'),
      [
        "import fs from 'node:fs'",
        "import { helper } from './util'",
        "import { z } from 'zod'",
        'export const value = helper(fs, z)',
        '',
      ].join('\n'),
    )
  })

  afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  test('excludes node builtins from external dependencies', () => {
    const result = traceImportGraph({ repo: fixtureDir, entries: ['entry.mjs'] })

    expect(result.externalDependencies).toContain('zod')
    expect(result.externalDependencies).not.toContain('fs')
    expect(result.externalDependencies).not.toContain('node:fs')
  })

  test('resolves a relative import to a local edge', () => {
    const result = traceImportGraph({ repo: fixtureDir, entries: ['entry.mjs'] })

    const localEdges = result.edges.filter((edge) => edge.kind === 'local')
    const utilEdge = localEdges.find((edge) => edge.specifier === './util')

    expect(utilEdge).toBeDefined()
    expect(utilEdge.resolved).toBe('util.mjs')
  })
})
