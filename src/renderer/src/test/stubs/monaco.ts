/** `monaco-editor` for the dom project: an editor that owns an empty div. */
const model = {
  getValue: () => '',
  setValue: () => {},
  getLineCount: () => 1,
  onDidChangeContent: () => ({ dispose: () => {} }),
  dispose: () => {},
  uri: { toString: () => '' }
}
const instance = {
  getModel: () => model,
  setModel: () => {},
  getValue: () => '',
  setValue: () => {},
  layout: () => {},
  focus: () => {},
  dispose: () => {},
  onDidChangeModelContent: () => ({ dispose: () => {} }),
  onDidChangeCursorPosition: () => ({ dispose: () => {} }),
  onDidFocusEditorText: () => ({ dispose: () => {} }),
  onDidBlurEditorText: () => ({ dispose: () => {} }),
  addCommand: () => null,
  addAction: () => ({ dispose: () => {} }),
  updateOptions: () => {},
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  setPosition: () => {},
  revealLineInCenter: () => {},
  deltaDecorations: () => [],
  createDecorationsCollection: () => ({ set: () => {}, clear: () => {} })
}
export const editor = {
  create: () => instance,
  createDiffEditor: () => ({ ...instance, setModel: () => {} }),
  createModel: () => model,
  getModel: () => null,
  getModels: () => [],
  setTheme: () => {},
  defineTheme: () => {},
  setModelLanguage: () => {},
  setModelMarkers: () => {},
  onDidCreateEditor: () => ({ dispose: () => {} })
}
export const languages = {
  register: () => {},
  getLanguages: () => [],
  registerCompletionItemProvider: () => ({ dispose: () => {} }),
  registerHoverProvider: () => ({ dispose: () => {} }),
  registerDefinitionProvider: () => ({ dispose: () => {} }),
  setMonarchTokensProvider: () => ({ dispose: () => {} }),
  setLanguageConfiguration: () => ({ dispose: () => {} }),
  typescript: { typescriptDefaults: { setCompilerOptions: () => {} } }
}
export const Uri = { parse: (s: string) => ({ toString: () => s }), file: (s: string) => ({ toString: () => s }) }
export class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}
export class Position {
  constructor(
    public lineNumber: number,
    public column: number
  ) {}
}
export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 }
export const KeyCode = new Proxy({}, { get: () => 0 }) as Record<string, number>
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 }
