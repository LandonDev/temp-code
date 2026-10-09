import { CreditCard, ExternalLink } from 'lucide-react'
import type { ServiceId, ServiceView, UsageReport } from 'aliax-core/shared/types'
import { Button } from '@aliax/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@aliax/components/ui/tooltip'
import { percentLeft } from '@aliax/lib/accounts'
import { cn } from '@aliax/lib/utils'
import { Empty, Panel, Stat } from './panel'

interface Row {
  key: string
  account: string
  service: string
  billingUrl?: string
  plan: string
  monthlyUsd?: number
  renewsAt?: number
  daysAway: number | null
  /** Most of any single limit this account has consumed this cycle. */
  usedPeak: number | null
}

const money = (n: number): string => `$${n.toLocaleString()}`

function build(
  views: ServiceView[],
  usage: Partial<Record<ServiceId, UsageReport[]>>,
  now: number
): Row[] {
  const rows: Row[] = []
  for (const s of views) {
    for (const p of s.profiles) {
      const report = usage[s.id]?.find((r) => r.profileName === p.name)
      const plan = report?.plan
      if (!plan) continue
      const usedPeak =
        report && report.windows.length > 0
          ? Math.round(100 - Math.min(...report.windows.map(percentLeft)))
          : null
      rows.push({
        key: `${s.id}:${p.name}`,
        account: p.nickname ?? p.email ?? p.name,
        service: s.name,
        billingUrl: s.billingUrl,
        plan: plan.name,
        monthlyUsd: plan.monthlyUsd,
        renewsAt: plan.renewsAt,
        daysAway:
          plan.renewsAt !== undefined ? Math.ceil((plan.renewsAt - now) / 86_400_000) : null,
        usedPeak
      })
    }
  }
  return rows.sort((a, b) => (a.daysAway ?? 999) - (b.daysAway ?? 999))
}

/**
 * What the whole set of accounts costs, when each bills next, and how much of
 * what you pay for you actually used. A short ranked table beats a chart here —
 * every column is a different kind of thing, and there are only a few rows.
 */
export function Subscriptions({
  views,
  usage,
  now
}: {
  views: ServiceView[]
  usage: Partial<Record<ServiceId, UsageReport[]>>
  now: number
}) {
  const rows = build(views, usage, now)
  const monthly = rows.reduce((a, r) => a + (r.monthlyUsd ?? 0), 0)
  const next = rows.find((r) => r.daysAway !== null && r.daysAway >= 0)
  // Paying full price for an account you barely touch is the finding worth
  // surfacing; anything under a quarter used is worth a second look.
  const underused = rows.filter((r) => r.usedPeak !== null && r.usedPeak < 25 && r.monthlyUsd)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <Stat
          label="Monthly cost"
          value={monthly > 0 ? money(monthly) : '—'}
          sub={`${rows.length} subscription${rows.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="Next charge"
          value={next?.monthlyUsd !== undefined ? money(next.monthlyUsd) : '—'}
          sub={
            next
              ? `${next.account} · in ${next.daysAway} day${next.daysAway === 1 ? '' : 's'}`
              : 'nothing scheduled'
          }
          tone={next && next.daysAway !== null && next.daysAway <= 3 ? 'warning' : undefined}
        />
        <Stat
          label="Yearly at this rate"
          value={monthly > 0 ? money(monthly * 12) : '—'}
          sub="if nothing changes"
        />
        <Stat
          label="Barely used"
          value={String(underused.length)}
          sub={
            underused.length > 0
              ? `${money(underused.reduce((a, r) => a + (r.monthlyUsd ?? 0), 0))}/mo under 25% used`
              : 'every plan is earning its keep'
          }
          tone={underused.length > 0 ? 'warning' : 'good'}
        />
      </div>

      <Panel
        title="Subscriptions"
        hint="Cost, next bill, and how much you used this cycle"
        className="h-auto"
      >
        {rows.length === 0 ? (
          <Empty>No plan details yet.</Empty>
        ) : (
          <div className="px-4 pb-4">
            <div className="flex items-center gap-3 border-b border-border pb-1.5 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
              <span className="min-w-0 flex-1">Account</span>
              <span className="w-24">Plan</span>
              <span className="w-16 text-right">Cost</span>
              <span className="w-28 text-right">Renews</span>
              <span className="w-20 text-right">Used</span>
              <span className="w-8" />
            </div>
            <ul className="divide-y divide-border/60">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-3 py-2.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {r.account}
                    <span className="text-muted-foreground/60"> · {r.service}</span>
                  </span>
                  <span className="w-24 truncate text-muted-foreground">{r.plan}</span>
                  <span className="w-16 text-right font-medium tabular-nums">
                    {r.monthlyUsd !== undefined ? `${money(r.monthlyUsd)}/mo` : '—'}
                  </span>
                  <span
                    className={cn(
                      'w-28 text-right tabular-nums',
                      r.daysAway !== null && r.daysAway <= 3
                        ? 'text-ax-warning'
                        : 'text-muted-foreground'
                    )}
                  >
                    {r.renewsAt !== undefined
                      ? `${new Date(r.renewsAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric'
                        })} · ${r.daysAway}d`
                      : '—'}
                  </span>
                  <span
                    className={cn(
                      'w-20 text-right tabular-nums',
                      r.usedPeak === null
                        ? 'text-muted-foreground/50'
                        : r.usedPeak < 25
                          ? 'text-ax-warning'
                          : 'text-muted-foreground'
                    )}
                  >
                    {r.usedPeak === null ? '—' : `${r.usedPeak}%`}
                  </span>
                  <span className="flex w-8 justify-end">
                    {r.billingUrl && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Manage ${r.account} billing`}
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => window.aliax.openExternal(r.billingUrl as string)}
                          >
                            <ExternalLink />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Opens {r.service} billing in your browser. It shows whichever account
                          that browser is signed into.
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="flex items-center gap-1.5 pt-3 text-[11px] text-muted-foreground/70">
              <CreditCard className="size-3" />
              Renewal dates come from each billing anchor. Cancel on the provider&rsquo;s page.
            </p>
          </div>
        )}
      </Panel>
    </div>
  )
}
