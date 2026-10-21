/**
 * The user's editor as the desktop app launches it (src/main/editorLaunch.ts):
 * the choice the `editor.command` setting holds, what is installed, and the
 * target of one open. Shared by preload's bridge and the renderer.
 */
export type EditorId = 'idea' | 'code' | 'xed'
export type EditorChoice = EditorId | 'auto'
export const EDITOR_IDS: readonly EditorId[] = ['idea', 'code', 'xed']
export const EDITOR_LABELS: Record<EditorId, string> = {
  idea: 'IntelliJ IDEA',
  code: 'VS Code',
  xed: 'Xcode'
}

export interface EditorTarget {
  path: string
  line?: number
  column?: number
}

/** A Swift file under an `ios/` folder: Xcode's territory. */
export function isSwiftUnderIos(path: string): boolean {
  return /\.swift$/i.test(path) && /(^|\/)ios\//.test(path)
}

/**
 * Which editor opens `path`: the configured one when installed, else the
 * first installed of idea, code, xed; a Swift file under ios/ goes to
 * Xcode when Xcode is configured or IDEA is absent. Null when nothing is
 * installed.
 */
export function chooseEditor(
  configured: EditorChoice,
  installed: Record<EditorId, boolean>,
  path: string
): EditorId | null {
  if (isSwiftUnderIos(path) && installed.xed && (configured === 'xed' || !installed.idea)) return 'xed'
  if (configured !== 'auto' && installed[configured]) return configured
  return EDITOR_IDS.find((id) => installed[id]) ?? null
}

export interface EditorConfig {
  editor: EditorChoice
  installed: Record<EditorId, boolean>
  /** The editor an auto choice would open a plain source file in now. */
  effective: EditorId | null
}
