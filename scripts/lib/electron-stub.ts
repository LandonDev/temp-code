/**
 * A Bun preload for proofs that drive the registry in-process without an
 * Electron runtime (`bun --preload scripts/lib/electron-stub.ts <script>`):
 * the claude driver imports `nativeImage` for image attachments, which no
 * such proof sends. Everything else of Electron stays absent on purpose.
 */
import { plugin } from 'bun'

plugin({
  name: 'electron-stub',
  setup(build) {
    build.module('electron', () => ({
      loader: 'object',
      exports: {
        nativeImage: {
          createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) })
        }
      }
    }))
  }
})
