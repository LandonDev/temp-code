/**
 * Best-effort parse of a truncated JSON document — tool inputs stream as
 * `input_json_delta` fragments, and we want the object as it grows, not
 * just when it closes. Complete values parse normally; a string cut off
 * mid-value is returned as far as it got (that's the streaming file
 * content we count); a dangling key or half literal is dropped.
 */

const FAIL = Symbol('unparseable')

export function parsePartialJson(src: string): unknown | undefined {
  try {
    return JSON.parse(src)
  } catch {
    // fall through to the lenient parse
  }

  let i = 0
  const n = src.length
  const ws = (): void => {
    while (i < n && ' \t\n\r'.includes(src.charAt(i))) i++
  }

  const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }

  /** Cursor on the opening quote. Unterminated → returns the prefix. */
  const parseString = (): string => {
    i++
    let out = ''
    while (i < n) {
      const c = src.charAt(i)
      if (c === '"') {
        i++
        return out
      }
      if (c === '\\') {
        if (i + 1 >= n) break // escape cut at the stream edge — drop it
        const e = src.charAt(i + 1)
        if (e === 'u') {
          if (i + 6 > n) break
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16))
          i += 6
        } else {
          out += ESCAPES[e] ?? e
          i += 2
        }
      } else {
        out += c
        i++
      }
    }
    i = n
    return out
  }

  const parseValue = (): unknown => {
    ws()
    if (i >= n) throw FAIL
    const c = src.charAt(i)
    if (c === '"') return parseString()
    if (c === '{') return parseObject()
    if (c === '[') return parseArray()
    const start = i
    while (i < n && !',}]: \t\n\r'.includes(src.charAt(i))) i++
    const tok = src.slice(start, i)
    if (tok === '') throw FAIL
    if ('true'.startsWith(tok)) return true
    if ('false'.startsWith(tok)) return false
    if ('null'.startsWith(tok)) return null
    const num = Number(tok)
    if (!Number.isNaN(num)) return num
    const trimmed = tok.replace(/[.eE+-]+$/, '')
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
    throw FAIL
  }

  const parseObject = (): Record<string, unknown> => {
    i++
    const out: Record<string, unknown> = {}
    for (;;) {
      ws()
      if (i >= n) return out
      const c = src.charAt(i)
      if (c === '}') {
        i++
        return out
      }
      if (c === ',') {
        i++
        continue
      }
      if (c !== '"') return out
      const key = parseString()
      ws()
      if (i >= n || src.charAt(i) !== ':') return out // key without a value yet
      i++
      try {
        out[key] = parseValue()
      } catch {
        return out
      }
    }
  }

  const parseArray = (): unknown[] => {
    i++
    const out: unknown[] = []
    for (;;) {
      ws()
      if (i >= n) return out
      const c = src.charAt(i)
      if (c === ']') {
        i++
        return out
      }
      if (c === ',') {
        i++
        continue
      }
      try {
        out.push(parseValue())
      } catch {
        return out
      }
    }
  }

  try {
    ws()
    if (i >= n) return undefined
    return parseValue()
  } catch {
    return undefined
  }
}
