import { describe, expect, it } from 'vitest'
import { CALL_MARK, NICE_LEVEL, NICE_PRELUDE, THREAD_MARK, unwrapBashCommand } from './bashMarks'

describe('bash marks', () => {
  it('strips the guard export ahead of a command, quoted ids included', () => {
    expect(unwrapBashCommand(`export ${THREAD_MARK}='s1' ${CALL_MARK}='toolu_1'; bun test`)).toBe('bun test')
    expect(unwrapBashCommand(`export ${THREAD_MARK}='it'\\''s' ${CALL_MARK}='c'; echo 'hi'; cd x`)).toBe("echo 'hi'; cd x")
  })

  it('strips the priority prelude after the marks, and only there', () => {
    expect(unwrapBashCommand(`export ${THREAD_MARK}='s1' ${CALL_MARK}='c'; ${NICE_PRELUDE}bun test`)).toBe('bun test')
    expect(unwrapBashCommand(`export ${THREAD_MARK}='s1' ${CALL_MARK}='c' TEMP_CODE_INSTANCE='i'; ${NICE_PRELUDE}echo 'hi'; cd x`)).toBe("echo 'hi'; cd x")
    // The prelude alone, with no marks ahead of it, is not the wrapper's and stays.
    expect(unwrapBashCommand(`${NICE_PRELUDE}bun test`)).toBe(`${NICE_PRELUDE}bun test`)
    expect(NICE_PRELUDE).toBe(`renice -n ${NICE_LEVEL} -p $$ >/dev/null 2>&1; ionice -c 3 -p $$ >/dev/null 2>&1; `)
  })

  it('leaves a command without the marks, or with them later in the text, as it is', () => {
    expect(unwrapBashCommand('bun test')).toBe('bun test')
    const later = `echo x; export ${THREAD_MARK}='s1' ${CALL_MARK}='c'; ls`
    expect(unwrapBashCommand(later)).toBe(later)
  })
})
