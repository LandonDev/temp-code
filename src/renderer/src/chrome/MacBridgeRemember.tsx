import { useEffect, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import {
  forgetMacBridgeRules,
  loadMacBridgeRules,
  ruleText,
  runRememberOptions,
  useMacBridgeRules,
  type RunRememberChoice
} from '../lib/macBridgeRules'
import { Button } from '../components/ui/button'
import { Item, ItemActions, ItemContent, ItemTitle } from '../components/ui/item'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { DANGER_GHOST, Group } from '../surfaces/settings/hosts/Group'
import { errorText } from './ConfirmDialog'

/**
 * The Mac bridge's remember controls (docs/box.md "Remembered approvals"):
 * the select on a run card (MacBridgeCards), and the list of one thread's
 * remembered approvals with Remove and Forget all (the thread menu's
 * "Mac approvals…" and Settings → Hosts).
 */

export function RunRememberSelect({
  request,
  value,
  onChange
}: {
  request: MacBridgeRequest
  value: RunRememberChoice
  onChange: (c: RunRememberChoice) => void
}) {
  const options = runRememberOptions(request)
  if (options.length === 0)
    return (
      <div className="text-xs text-muted-foreground">
        Asks every time ({request.alwaysAsk}): nothing can be remembered for it.
      </div>
    )
  return (
    <Select items={options} value={value} onValueChange={(v) => v && onChange(v as RunRememberChoice)}>
      <SelectTrigger size="sm" aria-label="Remember for this thread" data-mac-bridge-remember className="w-full min-w-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** One thread's remembered approvals as rows, each with Remove, and Forget all. */
export function MacBridgeRuleList({ sessionId, empty }: { sessionId: string; empty?: string }) {
  const rules = useMacBridgeRules(sessionId)
  const [error, setError] = useState<string | null>(null)
  const forget = async (ruleId?: string) => {
    setError(null)
    try {
      await forgetMacBridgeRules(sessionId, ruleId)
    } catch (err) {
      setError(errorText(err))
    }
  }
  if (rules.length === 0)
    return empty ? <p className="text-xs text-muted-foreground">{empty}</p> : null
  return (
    <div className="flex flex-col" data-mac-bridge-rules={sessionId}>
      {rules.map((rule) => {
        const { what, detail } = ruleText(rule)
        return (
          <Item key={rule.id} size="xs" className="px-0" data-mac-bridge-rule={rule.id}>
            <ItemContent className="min-w-0">
              <ItemTitle className="block max-w-full truncate text-xs font-normal text-muted-foreground">
                {what} <span className="font-mono text-foreground">{detail}</span>
              </ItemTitle>
            </ItemContent>
            <ItemActions className="shrink-0">
              {rule.uses ? <span className="text-xs tabular-nums text-muted-foreground">used {rule.uses}×</span> : null}
              <Button variant="ghost" size="xs" className={DANGER_GHOST} onClick={() => void forget(rule.id)}>
                Remove
              </Button>
            </ItemActions>
          </Item>
        )
      })}
      <div className="flex justify-end">
        <Button variant="ghost" size="xs" className={DANGER_GHOST} onClick={() => void forget()}>
          Forget all
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/** Settings → Hosts, this Mac's section: every thread's remembered approvals, by thread, until the app quits. */
export function MacBridgeRememberedSection() {
  const rules = useMacBridgeRules()
  useEffect(() => {
    void loadMacBridgeRules()
    const t = window.setInterval(() => void loadMacBridgeRules(), 5000)
    return () => window.clearInterval(t)
  }, [])
  const threads = [...new Map(rules.map((r) => [r.sessionId, r])).values()]
  if (threads.length === 0) return null
  return (
    <Group title="Remembered approvals" data-mac-bridge-remembered={threads.length}>
      {threads.map((r) => (
        <div key={r.sessionId} className="flex flex-col pt-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="min-w-0 truncate font-medium text-foreground">{r.threadTitle || r.sessionId}</span>
            <span className="shrink-0 text-muted-foreground">{r.hostName}</span>
          </div>
          <MacBridgeRuleList sessionId={r.sessionId} />
        </div>
      ))}
    </Group>
  )
}
