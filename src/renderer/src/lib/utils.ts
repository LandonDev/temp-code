import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Paths for display: relative to the project root when inside it,
 *  `~/…` otherwise — never a full absolute path. */
export function displayPath(path: string, root?: string | null): string {
  if (root) {
    const r = root.replace(/\/$/, '')
    if (path === r) return '.'
    if (path.startsWith(`${r}/`)) return path.slice(r.length + 1)
  }
  return path.replace(/^\/Users\/[^/]+/, '~')
}
