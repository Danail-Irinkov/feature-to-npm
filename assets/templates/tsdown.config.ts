import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  shims: true,
  publint: 'ci-only',
  attw: 'ci-only',
  failOnWarn: 'ci-only',
})
