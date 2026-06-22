import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const LICENSE = 'MIT'
const PACKAGE_NAME = 'demo-pkg'
const extractScript = fileURLToPath(new URL('../scripts/extract-feature.mjs', import.meta.url))

describe('extract-feature scaffold', () => {
  let sourceDir
  let targetDir

  beforeAll(() => {
    // A minimal 2-file feature: a public entry that imports one local module.
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2npm-src-'))
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2npm-out-'))
    fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(sourceDir, 'src', 'util.ts'),
      'export function helper(name: string): string {\n  return `hello ${name}`\n}\n',
    )
    fs.writeFileSync(
      path.join(sourceDir, 'src', 'index.ts'),
      "import { helper } from './util'\n\nexport function greet(name: string): string {\n  return helper(name)\n}\n",
    )

    try {
      execFileSync(
        process.execPath,
        [
          extractScript,
          '--source', sourceDir,
          '--target', targetDir,
          '--package', PACKAGE_NAME,
          '--description', 'Demo package for the extract smoke test',
          '--entry', 'src/index.ts',
          '--license', LICENSE,
          '--force',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      )
    } catch (error) {
      throw new Error(`extract-feature.mjs failed:\n${error.stderr || error.stdout || error.message}`)
    }
  }, 30000)

  afterAll(() => {
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true })
    if (targetDir) fs.rmSync(targetDir, { recursive: true, force: true })
  })

  test('generates a package.json with the expected publish surface', () => {
    const pkgPath = path.join(targetDir, 'package.json')
    expect(fs.existsSync(pkgPath)).toBe(true)

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

    expect(pkg.name).toBe(PACKAGE_NAME)
    expect(pkg.exports).toBeDefined()
    expect(pkg.exports['.']).toBeDefined()
    expect(pkg.files).toContain('dist')
    expect(pkg.license).toBe(LICENSE)
  })
})
