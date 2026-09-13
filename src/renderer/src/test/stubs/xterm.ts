/** `@xterm/xterm` for the dom project: a terminal that renders nothing. */
export class Terminal {
  element: HTMLElement | undefined
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  buffer = { active: { cursorY: 0, cursorX: 0, length: 0, getLine: () => undefined } }
  open(parent: HTMLElement): void {
    this.element = parent
  }
  write(): void {}
  writeln(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }
  focus(): void {}
  blur(): void {}
  clear(): void {}
  reset(): void {}
  dispose(): void {}
  loadAddon(): void {}
  attachCustomKeyEventHandler(): void {}
  onData(): { dispose: () => void } {
    return { dispose: () => {} }
  }
  onResize(): { dispose: () => void } {
    return { dispose: () => {} }
  }
  onKey(): { dispose: () => void } {
    return { dispose: () => {} }
  }
}
