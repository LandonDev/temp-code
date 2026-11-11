/** Codex's Mac medians from the 2026-11-10 field test (§27.14). */
export const FIELD_TARGETS = {
  version: '2026-11-10',
  targets: [
    { tasks: [{ id: 'field-calc', version: 2 }], seconds: 24, calls: 4 },
    { tasks: [{ id: 'field-web-form', version: 1 }], seconds: 26, calls: 6 },
    { tasks: [{ id: 'field-textedit-add-line', version: 1 }], seconds: 17, calls: 3 },
    { tasks: [{ id: 'field-textedit-save-as', version: 2 }], seconds: 31, calls: 5 },
    {
      tasks: [
        { id: 'field-finder-rename', version: 3 },
        { id: 'field-finder-trash', version: 3 },
        { id: 'field-finder-new-folder', version: 3 }
      ],
      seconds: 36,
      calls: 7
    }
  ]
} as const
