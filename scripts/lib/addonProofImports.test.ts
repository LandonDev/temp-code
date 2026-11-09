import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { resolve } from 'node:path'

it('the grants proof can load in Bun without importing node:sqlite', async () => {
  const result = await build({
    entryPoints: [resolve('scripts/e2e-addon-grants.ts')],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    alias: { 'aliax-core': resolve('node_modules/aliax-core/src') }
  })
  // Inputs include modules tree-shaking might drop: Bun still loads root
  // re-exports when running the source file without a bundle.
  const imports = Object.values(result.metafile!.inputs).flatMap((input) => input.imports)
  expect(imports.some((entry) => entry.path === 'node:sqlite')).toBe(false)
  expect(Object.keys(result.metafile!.inputs).some((path) => path.endsWith('/vault.ts'))).toBe(true)
})
