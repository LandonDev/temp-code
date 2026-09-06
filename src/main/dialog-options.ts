/**
 * Donor dialog options (`@tauri-apps/plugin-dialog`) mapped onto Electron's.
 * Pure, so the mapping is testable without opening a modal.
 */

export type DialogKind = 'info' | 'warning' | 'error'

export interface OpenOptions {
  title?: string
  defaultPath?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

export interface AskOptions {
  title?: string
  kind?: DialogKind
  okLabel?: string
  cancelLabel?: string
}

export interface MessageOptions {
  title?: string
  kind?: DialogKind
}

export type OpenProperty =
  | 'openFile'
  | 'openDirectory'
  | 'createDirectory'
  | 'multiSelections'

export interface OpenDialogArgs {
  title?: string
  defaultPath?: string
  properties: OpenProperty[]
  filters?: { name: string; extensions: string[] }[]
}

export function openDialogOptions(options: OpenOptions = {}): OpenDialogArgs {
  const properties: OpenProperty[] = options.directory
    ? ['openDirectory', 'createDirectory']
    : ['openFile']
  if (options.multiple) properties.push('multiSelections')
  return {
    ...(options.title ? { title: options.title } : {}),
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    properties,
    ...(options.filters?.length ? { filters: options.filters } : {})
  }
}

/** Canceled is null; a single pick is a bare string unless `multiple` asked. */
export function openDialogResult(
  canceled: boolean,
  paths: string[],
  options: OpenOptions = {}
): string | string[] | null {
  if (canceled || paths.length === 0) return null
  return options.multiple ? paths : paths[0]
}

export interface MessageBoxArgs {
  type: DialogKind
  title: string
  message: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

export function askBoxOptions(text: string, options: AskOptions = {}): MessageBoxArgs {
  return {
    type: options.kind ?? 'info',
    title: options.title ?? '',
    message: text,
    buttons: [options.okLabel ?? 'Yes', options.cancelLabel ?? 'No'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
}

export function messageBoxOptions(text: string, options: MessageOptions = {}): MessageBoxArgs {
  return {
    type: options.kind ?? 'info',
    title: options.title ?? '',
    message: text,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
}
