import { memo } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'

import { useApp } from '../../../state/store'
import { summarizeCommand } from '../../../lib/command-summary'
import { Button } from '../../ui/button'
import type { Block } from '../../../state/blocks'

type ApprovalBlock = Extract<Block, { kind: 'approval' }>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What exactly is being approved, shaped per tool — never raw JSON. */
function ApprovalDetail({
  toolName,
  input
}: {
  toolName: string
  input: unknown
}): React.JSX.Element | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>

  if (toolName === 'Bash' || toolName === 'shell' || toolName === 'Shell') {
    const s = summarizeCommand(str(i.command))
    return (
      <div className="border-t px-3 py-2">
        <div className="text-xs text-muted-foreground">{s.doing}</div>
        <div className="mt-1 flex gap-1.5 font-mono text-xs leading-5">
          <span className="select-none text-muted-foreground/50">$</span>
          <span className="whitespace-pre-wrap break-all">{s.command}</span>
        </div>
      </div>
    )
  }

  const file = str(i.file_path) || str(i.notebook_path) || str(i.path)
  if (file) {
    const content = str(i.content) || str(i.new_string) || str(i.new_source)
    const lines = content.split('\n').slice(0, 10)
    return (
      <div className="border-t px-3 py-2">
        <div className="truncate font-mono text-[11px] text-muted-foreground">{file}</div>
        {content && (
          <div className="mt-1.5 max-h-40 overflow-auto font-mono text-[11px] leading-[1.5]">
            {lines.map((l, n) => (
              <div
                key={n}
                className="bg-success/10 px-1.5 whitespace-pre-wrap break-all text-success"
              >
                + {l || ' '}
              </div>
            ))}
            {content.split('\n').length > 10 && (
              <div className="px-1.5 text-muted-foreground/60">…</div>
            )}
          </div>
        )}
      </div>
    )
  }

  const entries = Object.entries(i).filter(([, v]) => typeof v === 'string' && v)
  if (!entries.length) return null
  return (
    <div className="space-y-1 border-t px-3 py-2">
      {entries.slice(0, 4).map(([k, v]) => (
        <div key={k} className="text-xs">
          <span className="text-muted-foreground/70">{k}</span>{' '}
          <span className="font-mono break-all">{str(v).slice(0, 300)}</span>
        </div>
      ))}
    </div>
  )
}

/** The harness asked; the user answers here (docs/PLAN.md M4).
 *  `sessionId` is the session that OWNS the request — inside an agent
 *  drill-in that's the subagent, never the selected thread. */
export const ApprovalCard = memo(function ApprovalCard({
  block,
  sessionId
}: {
  block: ApprovalBlock
  sessionId: string
}): React.JSX.Element {
  const approve = useApp((s) => s.approve)
  const answer = (allow: boolean): void => {
    void approve(sessionId, block.requestId, allow)
  }

  if (block.resolved) {
    return (
      <div className="flex max-w-[95%] items-center gap-2 text-xs text-muted-foreground">
        {block.allow ? <Check className="size-3.5" /> : <X className="size-3.5" />}
        <span>
          {block.toolName} {block.allow ? 'approved' : block.auto ? 'denied (timed out)' : 'denied'}
        </span>
      </div>
    )
  }

  return (
    <div className="max-w-[95%] rounded-lg border border-warning/50 bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ShieldQuestion className="size-4 shrink-0 text-warning" />
        <span className="text-[13px]">
          {block.title ?? `Claude wants to use ${block.toolName}`}
        </span>
      </div>
      <ApprovalDetail toolName={block.toolName} input={block.input} />
      <div className="flex justify-end gap-2 border-t px-3 py-2">
        <Button variant="outline" size="sm" onClick={() => answer(false)}>
          Deny
        </Button>
        <Button size="sm" onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </div>
  )
})
