/**
 * The AX reader's quoting vectors: names, values and titles as JSON.stringify
 * writes them (docs/computer-protocol.md §4.1), which the Swift `Quote.json`
 * must match byte for byte (AXTextTests RenderTests).
 *
 *   bun scripts/quote-vectors.ts   writes native/tc-computer/Tests/AXTextTests/QuoteVectors.json
 *
 * scripts/gen-swift-computer.test.ts holds the committed file to this list.
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const controls = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('')

/** Every input Swift has to quote as JavaScript does; no lone surrogates (a Swift String cannot hold one). */
export const QUOTE_INPUTS: string[] = [
  'plain',
  '',
  'She said "hi"',
  'back\\slash',
  'path/with/slashes </script>',
  controls,
  'tab\there, line\nbreak, return\r, feed\f, bell\u0007, backspace\b',
  'del\u007f and nel\u0085',
  'line and paragraph separators',
  'bom﻿',
  'é and é',
  'emoji 👋 🧪 and a family 👨‍👩‍👧',
  'مرحبا بالعالم שלום',
  'ünïcödé — “quotes” ‘single’ …'
]

export const quoteVectors = (): string => JSON.stringify(QUOTE_INPUTS.map((input) => ({ input, quoted: JSON.stringify(input) })), null, 2) + '\n'

export const QUOTE_VECTORS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'tc-computer', 'Tests', 'AXTextTests', 'QuoteVectors.json')

if (import.meta.main) writeFileSync(QUOTE_VECTORS_PATH, quoteVectors())
