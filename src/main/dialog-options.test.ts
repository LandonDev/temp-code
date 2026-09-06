import { describe, expect, it } from 'vitest'
import {
  askBoxOptions,
  messageBoxOptions,
  openDialogOptions,
  openDialogResult
} from './dialog-options'

describe('open dialog', () => {
  it('maps the donor options', () => {
    expect(openDialogOptions({ directory: true, multiple: true, title: 'Pick' })).toEqual({
      title: 'Pick',
      properties: ['openDirectory', 'createDirectory', 'multiSelections']
    })
    expect(
      openDialogOptions({ filters: [{ name: 'Images', extensions: ['png'] }], defaultPath: '/tmp' })
    ).toEqual({
      defaultPath: '/tmp',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png'] }]
    })
  })

  it('returns a bare string unless several were asked for', () => {
    expect(openDialogResult(false, ['/a', '/b'], { multiple: true })).toEqual(['/a', '/b'])
    expect(openDialogResult(false, ['/a'], {})).toBe('/a')
    expect(openDialogResult(true, [], {})).toBe(null)
    expect(openDialogResult(false, [], {})).toBe(null)
  })
})

describe('message boxes', () => {
  it('puts the affirmative first and lets escape cancel', () => {
    const opts = askBoxOptions('Discard?', { okLabel: 'Discard', kind: 'warning', title: 'Wait' })
    expect(opts.buttons).toEqual(['Discard', 'No'])
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(1)
    expect(opts.type).toBe('warning')
    expect(opts.title).toBe('Wait')
    expect(opts.message).toBe('Discard?')
  })

  it('shows one button for a plain message', () => {
    expect(messageBoxOptions('Saved', {}).buttons).toEqual(['OK'])
    expect(messageBoxOptions('Saved', { kind: 'error' }).type).toBe('error')
  })
})
