/**
 * The ax wait rows from saved field or bench reports (docs/computer-protocol.md §27.3), and the A/B's verdict.
 *
 *   bun scripts/ax-wait-rows.ts rows a.json [b.json …]                     the rows, as TEMP_CODE_COMPUTER_WAIT_AX takes them
 *   bun scripts/ax-wait-rows.ts judge --shipped a.json … --trial b.json …   keep the trial rows only when nothing rose
 */
import { readFileSync } from 'node:fs'
import { axWaitRows, keepNewRows } from './lib/axWaitRule'
import type { BenchReport } from './lib/computerBench'

const read = (paths: string[]): BenchReport[] => paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as BenchReport)

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'rows' && rest.length) {
  console.log(JSON.stringify(axWaitRows(read(rest))))
} else if (mode === 'judge') {
  const at = rest.indexOf('--trial')
  const shipped = rest.slice(rest.indexOf('--shipped') + 1, at)
  const trial = rest.slice(at + 1)
  if (rest[0] !== '--shipped' || at < 0 || !shipped.length || !trial.length) throw new Error('judge --shipped <reports> --trial <reports>')
  const { keep, lines } = keepNewRows(read(shipped), read(trial))
  console.log([...lines, keep ? 'keep the trial rows' : 'keep the shipped rows'].join('\n'))
  process.exitCode = keep ? 0 : 1
} else {
  console.error('usage: bun scripts/ax-wait-rows.ts rows <reports> | judge --shipped <reports> --trial <reports>')
  process.exitCode = 2
}
