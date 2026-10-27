import { describe, expect, it } from 'vitest'
import { CALL_MARK, THREAD_MARK, unwrapBashCommand } from './bashMarks'

describe('bash marks', () => {
  it('strips the guard export ahead of a command, quoted ids included', () => {
    expect(unwrapBashCommand(`export ${THREAD_MARK}='s1' ${CALL_MARK}='toolu_1'; bun test`)).toBe('bun test')
    expect(unwrapBashCommand(`export ${THREAD_MARK}='it'\\''s' ${CALL_MARK}='c'; echo 'hi'; cd x`)).toBe("echo 'hi'; cd x")
  })

  it('leaves a command without the marks, or with them later in the text, as it is', () => {
    expect(unwrapBashCommand('bun test')).toBe('bun test')
    const later = `echo x; export ${THREAD_MARK}='s1' ${CALL_MARK}='c'; ls`
    expect(unwrapBashCommand(later)).toBe(later)
  })
})
