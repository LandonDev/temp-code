import { memo } from 'react'
import { cn } from '../../lib/utils'
import command from '../../assets/zicons/command.svg?raw'
import document from '../../assets/zicons/document.svg?raw'
import documentAdd from '../../assets/zicons/document-add.svg?raw'
import pen from '../../assets/zicons/pen.svg?raw'
import magnifer from '../../assets/zicons/magnifer.svg?raw'
import folderWithFiles from '../../assets/zicons/folder-with-files.svg?raw'
import global from '../../assets/zicons/global.svg?raw'
import checklist from '../../assets/zicons/checklist.svg?raw'
import widget from '../../assets/zicons/widget.svg?raw'
import dangerTriangle from '../../assets/zicons/danger-triangle.svg?raw'
import chatRoundLine from '../../assets/zicons/chat-round-line.svg?raw'
import paperclip from '../../assets/zicons/paperclip.svg?raw'
import arrowUp from '../../assets/zicons/arrow-up.svg?raw'
import arrowDown from '../../assets/zicons/arrow-down.svg?raw'
import stop from '../../assets/zicons/stop.svg?raw'
import altArrowDown from '../../assets/zicons/alt-arrow-down.svg?raw'
import altArrowRight from '../../assets/zicons/alt-arrow-right.svg?raw'
import check from '../../assets/zicons/check.svg?raw'
import close from '../../assets/zicons/close.svg?raw'
import gitBranch from '../../assets/zicons/git-branch.svg?raw'
import folder from '../../assets/zicons/folder.svg?raw'
import expandArrows from '../../assets/zicons/expand-arrows.svg?raw'
import terminal from '../../assets/zicons/terminal.svg?raw'
import documentText from '../../assets/zicons/document.svg?raw'
import claudeMark from '../../assets/zicons/claude-mark.svg?raw'
import openaiMark from '../../assets/zicons/openai-mark.svg?raw'
import cursorMark from '../../assets/zicons/cursor-mark.svg?raw'
import githubMark from '../../assets/zicons/github-mark.svg?raw'
import gitlabMark from '../../assets/zicons/gitlab-mark.svg?raw'
import star from '../../assets/zicons/star.svg?raw'
import starBold from '../../assets/zicons/star-bold.svg?raw'
import settingsMinimalistic from '../../assets/zicons/settings-minimalistic.svg?raw'
import archiveMinimalistic from '../../assets/zicons/archive-minimalistic.svg?raw'
import archiveUpMinimalistic from '../../assets/zicons/archive-up-minimalistic.svg?raw'

/** Solar line icons, the exact SVGs Zeron ships. They draw with
 *  stroke: currentColor at 1em — size via fontSize, color via text-*. */
const ICONS = {
  command,
  document,
  'document-add': documentAdd,
  pen,
  magnifer,
  'folder-with-files': folderWithFiles,
  global,
  checklist,
  widget,
  'danger-triangle': dangerTriangle,
  'chat-round-line': chatRoundLine,
  paperclip,
  'arrow-up': arrowUp,
  'arrow-down': arrowDown,
  stop,
  'alt-arrow-down': altArrowDown,
  'alt-arrow-right': altArrowRight,
  check,
  close,
  'git-branch': gitBranch,
  folder,
  'expand-arrows': expandArrows,
  terminal,
  'document-text': documentText,
  'claude-mark': claudeMark,
  'openai-mark': openaiMark,
  'cursor-mark': cursorMark,
  'github-mark': githubMark,
  'gitlab-mark': gitlabMark,
  star,
  'star-bold': starBold,
  'settings-minimalistic': settingsMinimalistic,
  'archive-minimalistic': archiveMinimalistic,
  'archive-up-minimalistic': archiveUpMinimalistic
} as const

export type ZIconName = keyof typeof ICONS

export const ZIcon = memo(function ZIcon({
  name,
  size = 12,
  className
}: {
  name: ZIconName
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      // size-[1em]: the brand marks ship viewBox-only (no 1em width/height
      // like the Solar set) — force every svg onto the fontSize box.
      className={cn(
        'inline-flex shrink-0 leading-none [&>svg]:block [&>svg]:size-[1em]',
        className
      )}
      style={{ fontSize: size }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  )
})
