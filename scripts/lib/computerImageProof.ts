import type { AgentEvent } from '../../src/shared/events'
import { parseShotLine } from '../../src/shared/computer/tools'

/** Judge transcript rows, never the prompt or the expected code's file. */
export function judgeComputerImages(
  events: AgentEvent[],
  letters: string,
  mode: string,
  pictures: number
) {
  const calls = events.filter((e) => e.type === 'tool-call')
  const results = events.filter((e) => e.type === 'tool-result')
  const paths = new Set(
    results.flatMap((e) => {
      let text = e.output
      try {
        const result = JSON.parse(text)
        if (Array.isArray(result?.content))
          text = result.content
            .filter((p: { type: string }) => p.type === 'text')
            .map((p: { text: string }) => p.text)
            .join('\n')
      } catch {
        /* Claude stores the text directly. */
      }
      return text
        .split('\n')
        .map(parseShotLine)
        .filter((s) => s !== null)
        .map((s) => s.path)
    })
  )
  const reads = calls.filter(
    (e) =>
      /read|view_image|shell|bash|exec/i.test(e.name) &&
      [...paths].some((p) => (JSON.stringify(e.input) ?? '').includes(p))
  )
  const views = reads.filter((e) => /view_image/i.test(e.name))
  const forbidden = mode === 'view' ? reads.filter((e) => !views.includes(e)) : reads
  const reply = events
    .flatMap((e) => (e.type === 'assistant-text' && !e.delta ? [e.text] : []))
    .join('\n')
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message)
  const reasons = [
    ...errors,
    ...(!reply.includes(letters) ? ['reply does not contain the code'] : []),
    ...(paths.size < pictures ? [`expected ${pictures} pictures, got ${paths.size}`] : []),
    ...(!calls.some(
      (e) =>
        /computer_observe$/.test(e.name) &&
        (e.input as { screenshot?: boolean })?.screenshot === true
    )
      ? ['no screenshot observation']
      : []),
    ...(forbidden.length ? [`opened a shot file: ${forbidden.map((e) => e.name).join(', ')}`] : []),
    ...(mode === 'view' && !views.length
      ? ['view mode never called view_image on a shot path']
      : [])
  ]
  return { pass: reasons.length === 0, reply, why: reasons.join('; '), paths: [...paths], reads }
}
