/**
 * Named-export shim for the CommonJS `electron` module, so headless
 * scripts can bundle the drivers and run under plain node. The drivers
 * touch electron only for image attachments (`nativeImage`), which no
 * script sends — an empty image keeps that path on its readFileSync
 * branch if one ever does.
 */
export const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 })
  })
}
