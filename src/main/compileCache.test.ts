import { describe, expect, it } from 'vitest'
import { compileCacheDir, compileCacheLine } from './compileCache'

const STATUS = { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 }

describe('compileCacheDir', () => {
  it('defaults to temp-code/compile-cache under the temp dir', () => {
    expect(compileCacheDir({}, '/tmp/x')).toBe('/tmp/x/temp-code/compile-cache')
  })
  it('takes TEMP_CODE_COMPILE_CACHE over the default', () => {
    expect(compileCacheDir({ TEMP_CODE_COMPILE_CACHE: '/private/tmp/h/cc' }, '/tmp/x')).toBe(
      '/private/tmp/h/cc'
    )
  })
  it('ignores an empty override', () => {
    expect(compileCacheDir({ TEMP_CODE_COMPILE_CACHE: '' }, '/tmp/x')).toBe(
      '/tmp/x/temp-code/compile-cache'
    )
  })
})

describe('compileCacheLine', () => {
  it('names the directory when enabled', () => {
    expect(compileCacheLine({ status: 1, directory: '/tmp/cc' }, STATUS)).toBe(
      'compile-cache ENABLED /tmp/cc'
    )
    expect(compileCacheLine({ status: 2, directory: '/tmp/cc' }, STATUS)).toBe(
      'compile-cache ALREADY_ENABLED /tmp/cc'
    )
  })
  it('carries the message when it failed', () => {
    expect(compileCacheLine({ status: 0, message: 'EACCES: permission denied' }, STATUS)).toBe(
      'compile-cache FAILED EACCES: permission denied'
    )
  })
  it('is bare when disabled', () => {
    expect(compileCacheLine({ status: 3 }, STATUS)).toBe('compile-cache DISABLED')
  })
  it('falls back to the number for an unknown status', () => {
    expect(compileCacheLine({ status: 9 }, STATUS)).toBe('compile-cache 9')
  })
})
