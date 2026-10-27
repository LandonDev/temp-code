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
import { errorText } from './ConfirmDialog'

/**
 * The Mac bridge's remember controls (docs/box.md "Remembered approvals"):
 * the select on a run card (MacBridgeCards), and the list of one thread's
 * remembered approvals with Remove and Forget all (the thread menu's
 * "Mac approvals…" and Settings → Remote access → Mac bridge).
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
      <div className="text-[11px] text-content/50">
        Asks every time ({request.alwaysAsk}): nothing can be remembered for it.
      </div>
    )
  return (
    <select
      aria-label="Remember for this thread"
      data-mac-bridge-remember
      value={value}
      onChange={(e) => onChange(e.target.value as RunRememberChoice)}
      className="w-full min-w-0 truncate rounded-md border border-content/10 bg-content/5 px-1.5 py-0.5 text-[11px] text-content/80 hover:border-content/20"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** One thread's remembered approvals, with Remove per rule and Forget all. */
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
    return empty ? <p className="text-[12px] text-content/40">{empty}</p> : null
  return (
    <div className="flex flex-col gap-1.5" data-mac-bridge-rules={sessionId}>
      {rules.map((rule) => {
        const { what, detail } = ruleText(rule)
        return (
          <div key={rule.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-[12px] text-content/80" title={detail}>
              {what} <span className="font-mono text-content/90">{detail}</span>
              {rule.uses ? <span className="text-content/40"> · used {rule.uses}×</span> : null}
            </span>
            <button
              type="button"
              className="pressable shrink-0 rounded-md border border-content/10 px-2 py-0.5 text-[11px] text-danger hover:border-danger/40 hover:bg-danger/10"
              onClick={() => void forget(rule.id)}
            >
              Remove
            </button>
          </div>
        )
      })}
      <div className="flex justify-end pt-1">
        <button
          type="button"
          className="pressable rounded-md px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
          onClick={() => void forget()}
        >
          Forget all
        </button>
      </div>
      {error ? <p className="text-[11px] text-danger">{error}</p> : null}
    </div>
  )
}

/** Settings → Remote access → Mac bridge: every thread's remembered approvals, by thread. */
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
    <div className="flex flex-col gap-3 pt-3">
      <div className="text-[12px] text-content/60">
        Remembered for threads (until the app quits)
      </div>
      {threads.map((r) => (
        <div key={r.sessionId} className="flex flex-col gap-1.5 pl-1">
          <div className="text-[12px] text-content/70">
            {r.threadTitle || r.sessionId} <span className="text-content/40">on {r.hostName}</span>
          </div>
          <MacBridgeRuleList sessionId={r.sessionId} />
        </div>
      ))}
    </div>
  )
}
