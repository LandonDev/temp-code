import { Copy, Eye } from 'lucide-react'
import { useApp } from '../../../state/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../../ui/context-menu'

/** Right-click on any file link: Reveal in Finder / Copy Path / Copy File
 *  Name. Left-click stays with the wrapped trigger. Relative targets
 *  resolve against the selected project's cwd; without one (loose chats),
 *  Reveal hides and Copy Path copies the path as written. */
export function FileRefMenu({
  target,
  children
}: {
  /** path as rendered — may be relative and carry a :line(:col) suffix */
  target: string
  children: React.ReactNode
}): React.JSX.Element {
  const cwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  if (!target) return <>{children}</>
  const clean = target.replace(/:\d+(?::\d+)?$/, '')
  const abs = clean.startsWith('/')
    ? clean
    : clean.startsWith('~')
      ? null
      : cwd
        ? `${cwd.endsWith('/') ? cwd : `${cwd}/`}${clean.replace(/^\.\//, '')}`
        : null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {abs && (
          <ContextMenuItem onClick={() => void window.api.revealInFinder(abs)}>
            <Eye className="size-3.5 text-muted-foreground" />
            Reveal in Finder
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(abs ?? clean)}>
          <Copy className="size-3.5 text-muted-foreground" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => void navigator.clipboard.writeText(clean.split('/').pop() ?? clean)}
        >
          <Copy className="size-3.5 text-muted-foreground" />
          Copy File Name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
