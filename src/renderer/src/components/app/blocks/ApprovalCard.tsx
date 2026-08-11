import { memo } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useApp } from '../../../state/store'
import { Button } from '../../ui/button'
import type { Block } from '../../../state/blocks'

type ApprovalBlock = Extract<Block, { kind: 'approval' }>

/** The harness asked; the user answers here (docs/PLAN.md M4). */
export const ApprovalCard = memo(function ApprovalCard({
  block
}: {
  block: ApprovalBlock
}): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedId)
  const approve = useApp((s) => s.approve)
  const answer = (allow: boolean): void => {
    if (selectedId) void approve(selectedId, block.requestId, allow)
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
        <span className="text-[13px]">{block.title ?? `Claude wants to use ${block.toolName}`}</span>
      </div>
      {block.input !== undefined && (
        <pre className="max-h-40 overflow-auto border-t px-3 py-2 text-xs text-muted-foreground">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
      <div className={cn('flex justify-end gap-2 px-3 py-2', block.input !== undefined && 'border-t')}>
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
