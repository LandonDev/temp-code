import { describe, expect, it } from 'vitest'
import { FIELD_TARGETS } from './lib/fieldTargets'
import { FIELD_TASKS } from './lib/fieldTasks'

describe('FIELD_TARGETS', () => {
  it('keeps Codex seconds and calls, with Finder judged as one group', () => {
    expect(FIELD_TARGETS.version).toBe('2026-11-10')
    expect(FIELD_TARGETS.targets.map((t) => [t.tasks.map((task) => task.id), t.seconds, t.calls])).toEqual([
      [['field-calc'], 24, 4],
      [['field-web-form'], 26, 6],
      [['field-textedit-add-line'], 17, 3],
      [['field-textedit-save-as'], 31, 5],
      [['field-finder-rename', 'field-finder-trash', 'field-finder-new-folder'], 36, 7]
    ])
  })

  it('pins each target to a real field task and its current version', () => {
    for (const task of FIELD_TARGETS.targets.flatMap((target) => [...target.tasks]))
      expect(FIELD_TASKS.find((field) => field.id === task.id)).toMatchObject({ id: task.id, version: task.version })
  })
})
