/**
 * Every `@codemirror/*` package for the dom project. Under vite-node a
 * missing named export reads as `undefined` instead of failing to link,
 * so this only has to carry what a mounted component calls at render
 * time. Add a name here when a dom test needs it.
 */
const disposable = { destroy: () => {}, dispose: () => {} }
const define = (): { of: () => object; define: () => object } => ({
  of: () => ({}),
  define: () => ({})
})

export class EditorState {
  doc = { toString: () => '', length: 0, lines: 1, line: () => ({ from: 0, to: 0, text: '' }) }
  selection = { main: { from: 0, to: 0, head: 0, anchor: 0 } }
  static create(): EditorState {
    return new EditorState()
  }
  update(): { state: EditorState } {
    return { state: this }
  }
  field(): undefined {
    return undefined
  }
  facet(): undefined {
    return undefined
  }
}

export class EditorView {
  state = EditorState.create()
  dom = document.createElement('div')
  contentDOM = this.dom
  scrollDOM = this.dom
  constructor(config?: { parent?: HTMLElement }) {
    config?.parent?.append(this.dom)
  }
  dispatch(): void {}
  focus(): void {}
  destroy(): void {}
  static updateListener = define()
  static theme = (): object => ({})
  static baseTheme = (): object => ({})
  static lineWrapping = {}
  static editable = define()
  static domEventHandlers = (): object => ({})
  static decorations = define()
}

export const StateEffect = { define }
export const StateField = { define }
export const Facet = { define }
export const Compartment = class {
  of(): object {
    return {}
  }
  reconfigure(): object {
    return {}
  }
}
export const Decoration = {
  mark: () => ({ range: () => ({}) }),
  line: () => ({ range: () => ({}) }),
  widget: () => ({ range: () => ({}) }),
  none: []
}
export const ViewPlugin = { fromClass: () => ({}), define: () => ({}) }
export const keymap = { of: () => ({}) }
export const Prec = { highest: (x: unknown) => x, high: (x: unknown) => x, low: (x: unknown) => x }
export const RangeSet = { empty: [] }
export const RangeSetBuilder = class {
  add(): void {}
  finish(): never[] {
    return []
  }
}
export const HighlightStyle = { define: () => ({}) }
export const syntaxHighlighting = (): object => ({})
export const defaultKeymap: never[] = []
export const history = (): object => ({})
export const historyKeymap: never[] = []
export const searchKeymap: never[] = []
export const linter = (): object => ({})
export const lintGutter = (): object => ({})
export const autocompletion = (): object => ({})
export const MergeView = class {
  dom = document.createElement('div')
  a = new EditorView()
  b = new EditorView()
  destroy(): void {
    disposable.destroy()
  }
}
