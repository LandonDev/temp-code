import { useState } from 'react'
import {
  CircleAlert,
  Clock,
  CreditCard,
  Download,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type {
  PlanInfo,
  ProfileView,
  ServiceId,
  ServiceView,
  UsageReport,
  UsageWindow
} from 'aliax-core/shared/types'
import { AnimatedNumber } from '@aliax/components/motion/animated-number'
import { Loader } from '@aliax/components/motion/loader'
import { BrandMark, SERVICE_TINT } from '@aliax/components/brand'
import { Alert, AlertDescription } from '@aliax/components/reui/alert'
import { Badge } from '@aliax/components/reui/badge'
import { IconTile } from '@aliax/components/reui/icon-tile'
import { Button } from '@aliax/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@aliax/components/ui/dropdown-menu'
import { Progress } from '@aliax/components/ui/progress'
import { Skeleton } from '@aliax/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@aliax/components/ui/tooltip'
import { EASE_OUT } from '@aliax/lib/ease'
import {
  DEFAULT_COLOR,
  cycleFraction,
  cycleMs,
  displayName,
  fillFor,
  isLive,
  onPaceLeft,
  percentLeft,
  resetLabel,
  resetPoint,
  toneFor,
  untilLabel,
  useNow
} from '@aliax/lib/accounts'
import { cn } from '@aliax/lib/utils'
import { EditAccountDialog } from '@aliax/views/edit-account-dialog'

/**
 * Base slots every service reserves so bars line up down the page. A service
 * showing per-model caps (Claude's Fable or Opus windows) widens to fit them,
 * and every row in that panel widens with it so the columns stay aligned.
 */
const BASE_SLOTS = 2
const MAX_SLOTS = 4

/** How far through the current refill cycle we are, drawn as a filling ring. */
function CycleRing({ fraction }: { fraction: number }) {
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="size-3.5 shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" className="stroke-white/12" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0.04, fraction))}
        className="stroke-foreground/70 transition-[stroke-dashoffset] duration-700"
      />
    </svg>
  )
}

function Bar({ w, now }: { w: UsageWindow; now: number }) {
  const left = percentLeft(w)
  const budget = onPaceLeft(w, now)
  const ahead = budget !== null && left >= budget
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{w.label}</span>
        <span className={cn('text-[13px] font-medium', toneFor(w, now))}>
          <AnimatedNumber
            value={left}
            duration={0.55}
            startOnView={false}
            format={(n) => `${Math.round(n)}%`}
          />
        </span>
      </div>
      <div className="relative mt-1.5">
        <Progress
          value={left}
          aria-label={`${w.label}: ${Math.round(left)} percent left`}
          className="h-1.5 bg-white/8"
          indicatorClassName={fillFor(w, now)}
        />
        {/* Where an even burn would put you. Fill past the tick means ahead. */}
        {budget !== null && budget > 2 && budget < 98 && (
          <span
            aria-hidden
            className={cn(
              'absolute -top-0.5 h-2.5 w-0.5 rounded-full',
              ahead ? 'bg-foreground/35' : 'bg-foreground/70'
            )}
            style={{ left: `calc(${budget}% - 1px)` }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * One refill clock, and every limit that shares it. A per-model cap resets with
 * the weekly window, so it stacks underneath as a second bar instead of
 * claiming a column and repeating the same countdown.
 */
function UsageCell({ group, now }: { group: UsageWindow[]; now: number }) {
  const head = group[0]
  const period = head.periodMs ?? cycleMs(head.label)
  const cell = (
    <div className="space-y-2">
      {group.map((w) => (
        <Bar key={w.label} w={w} now={now} />
      ))}
      <div className="flex h-3.5 items-center gap-1.5">
        {head.resetsAt && head.resetsAt > now && (
          <>
            {period && <CycleRing fraction={cycleFraction(head.resetsAt, period, now)} />}
            <span className="truncate text-[11px] text-muted-foreground">
              in {untilLabel(head.resetsAt, now)}
              <span className="text-muted-foreground/60"> · {resetPoint(head.resetsAt, now)}</span>
            </span>
          </>
        )}
      </div>
    </div>
  )
  if (!head.resetsAt) return cell
  return (
    <Tooltip>
      <TooltipTrigger asChild>{cell}</TooltipTrigger>
      <TooltipContent>
        <div>Refills {resetLabel(head.resetsAt)}</div>
        {onPaceLeft(head, now) !== null && (
          <div className="pt-0.5 text-muted-foreground">
            An even burn leaves you at {Math.round(onPaceLeft(head, now) as number)}% by now
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Group windows by the moment they refill, to the minute. */
function groupWindows(windows: UsageWindow[]): UsageWindow[][] {
  const groups: UsageWindow[][] = []
  for (const w of windows) {
    const key = w.resetsAt ? Math.round(w.resetsAt / 60_000) : null
    const found =
      key === null
        ? undefined
        : groups.find((g) => g[0].resetsAt && Math.round(g[0].resetsAt / 60_000) === key)
    if (found) found.push(w)
    else groups.push([w])
  }
  return groups
}

/** The provider is the panel this row sits in, so naming it again adds nothing. */
function rateLimitLabel(rl: NonNullable<UsageReport['rateLimit']>, now: number): string {
  if (rl.until === undefined) return 'Usage rate limited'
  const ms = rl.until - now
  if (ms <= 0) return 'Usage rate limited · retrying'
  const mins = Math.ceil(ms / 60_000)
  const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
  return `Usage rate limited · ${left} left`
}

/** Amber status line: the numbers above it are the last good ones, held while
 *  the provider refuses fresh calls. */
function RateLimitLine({ rl, now }: { rl: NonNullable<UsageReport['rateLimit']>; now: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-ax-warning">
      <Clock className="size-3 shrink-0" />
      {rateLimitLabel(rl, now)}
    </span>
  )
}

/**
 * The sign-in has expired. One click re-signs the same address — the whole line
 * is the button, so there's nothing to hunt for and nothing to read twice.
 */
function ExpiredLine({ onReauth }: { onReauth: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onReauth()
      }}
      className="flex items-center gap-1.5 text-[11px] text-ax-warning transition-colors hover:text-ax-warning/80"
    >
      <LogIn className="size-3 shrink-0" />
      <span>
        Session expired · <span className="underline underline-offset-2">Sign in</span>
      </span>
    </button>
  )
}

function UsageBlock({
  report,
  now,
  slots
}: {
  report?: UsageReport
  now: number
  slots: number
}) {
  // One cell is 10rem wide plus a 1.5rem gutter, so the block grows predictably.
  const style = { width: `${slots * 10 + (slots - 1) * 1.5}rem` }
  const grid = { ...style, gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }

  if (report === undefined) {
    return (
      <div className="grid shrink-0 gap-6" style={grid}>
        {Array.from({ length: slots }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2.5 h-1.5 w-full" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
    )
  }
  if (report.windows.length === 0) {
    // Rate-limited before this account ever reported usage, so there is nothing
    // to hold. Say that rather than showing a dash the reader has to decode; the
    // amber line under the name already gives the reason.
    return (
      <div className="flex shrink-0 items-center text-[13px] text-muted-foreground/70" style={style}>
        {report.rateLimit ? 'No usage recorded yet' : (report.note ?? report.extra ?? 'Usage unavailable')}
      </div>
    )
  }
  const groups = groupWindows(report.windows).slice(0, slots)
  return (
    <div className="grid shrink-0 gap-6" style={grid}>
      {groups.map((g, i) => (
        // Fill from the right: a service with one cycle (Cursor's monthly) sits
        // in the long-window column, aligned with the other services' weeklies.
        <div key={g[0].label} style={i === 0 ? { gridColumnStart: slots - groups.length + 1 } : undefined}>
          <UsageCell group={g} now={now} />
        </div>
      ))}
    </div>
  )
}

/**
 * What this account costs and when it bills again, with a ring showing how far
 * through the billing month you are — the same language the usage cells use for
 * their refill cycles, so one glance reads both.
 */
/**
 * Plain words for the raw subscription statuses the providers report. Claude
 * bills through Stripe, so its vocabulary is Stripe's; 'lapsed' is ours
 * (Codex, past its paid-through date). Anything unlisted shows as sent.
 */
const STATUS_TEXT: Record<string, string> = {
  canceled: "canceled · won't renew",
  cancelled: "canceled · won't renew",
  past_due: 'payment past due',
  unpaid: 'payment failed',
  incomplete: 'payment incomplete',
  incomplete_expired: 'payment expired',
  paused: 'paused',
  trialing: 'trial',
  lapsed: 'ended'
}
/** Statuses that are fine — no amber, no alarm. */
const STATUS_OK = new Set(['active', 'trialing'])

function PlanLine({ plan, now }: { plan: PlanInfo; now: number }) {
  const MONTH = 30 * 86_400_000
  const through =
    plan.renewsAt !== undefined ? Math.min(1, Math.max(0, 1 - (plan.renewsAt - now) / MONTH)) : null
  const days = plan.renewsAt !== undefined ? Math.ceil((plan.renewsAt - now) / 86_400_000) : null
  const shortDate = (t: number): string =>
    new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {plan.monthlyUsd !== undefined && (
            <span className="font-medium text-foreground/80">${plan.monthlyUsd}/mo</span>
          )}
          <span className="truncate">{plan.name}</span>
          {plan.cancelsAt !== undefined ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="whitespace-nowrap text-ax-warning">
                canceled · ends {shortDate(plan.cancelsAt)}
              </span>
            </>
          ) : plan.status && !STATUS_OK.has(plan.status) ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="whitespace-nowrap text-ax-warning">
                {STATUS_TEXT[plan.status] ?? plan.status.replace(/_/g, ' ')}
              </span>
            </>
          ) : (
            plan.renewsAt !== undefined && (
              <>
                <span className="text-muted-foreground/40">·</span>
                {through !== null && <CycleRing fraction={through} />}
                <span className="whitespace-nowrap">renews {shortDate(plan.renewsAt)}</span>
              </>
            )
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {plan.cancelsAt !== undefined
          ? `Canceled — won't renew. Access ends ${new Date(plan.cancelsAt).toLocaleDateString(
              undefined,
              { month: 'long', day: 'numeric' }
            )}`
          : days !== null
            ? `${days} day${days === 1 ? '' : 's'} until the next charge${
                plan.anchorDay ? ` (bills on the ${plan.anchorDay}${ordinal(plan.anchorDay)})` : ''
              }`
            : plan.status && !STATUS_OK.has(plan.status)
              ? `Subscription ${STATUS_TEXT[plan.status] ?? plan.status.replace(/_/g, ' ')}`
              : plan.name}
      </TooltipContent>
    </Tooltip>
  )
}

const ordinal = (n: number): string =>
  n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'

/** Codex banks a full limit reset when a window expires unused; show the stash. */
function BankedResets({ count }: { count?: number }) {
  if (!count || count <= 0) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-ax-success/25 bg-ax-success/10 py-1 pr-2.5 pl-2">
          <span className="flex -space-x-1">
            {Array.from({ length: Math.min(count, 4) }, (_, i) => (
              <span
                key={i}
                className="size-2.5 rounded-full bg-ax-success ring-2 ring-card"
                style={{ zIndex: 4 - i }}
              />
            ))}
          </span>
          <span className="text-[11px] font-medium text-ax-success">
            {count} banked
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {count} full limit reset{count === 1 ? '' : 's'} in the bank, ready to spend
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The switch control: each service is a pick-one list, so the account colour
 * doubles as a radio. Filled means in use; hovering a saved row previews the
 * fill about to happen. While switching, a spinner takes its place.
 */
function SwitchDot({ profile, busy }: { profile: ProfileView; busy: boolean }) {
  const color = profile.color ?? DEFAULT_COLOR
  if (busy) {
    return <Loader variant="spinner" size={16} className="shrink-0 text-muted-foreground" />
  }
  const live = isLive(profile)
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full transition-shadow"
      style={{ boxShadow: `inset 0 0 0 1.5px ${live ? color : `${color}66`}` }}
    >
      <span
        className={cn(
          'size-2 rounded-full transition-opacity',
          live ? 'opacity-100' : 'opacity-0 group-hover:opacity-45'
        )}
        style={{ backgroundColor: color }}
      />
    </span>
  )
}

function ProfileRow({
  serviceId,
  profile,
  report,
  busy,
  index,
  now,
  slots,
  billingUrl,
  onUse,
  onReauth,
  onDelete,
  onEdited
}: {
  serviceId: ServiceId
  profile: ProfileView
  report?: UsageReport
  busy: boolean
  index: number
  now: number
  slots: number
  billingUrl?: string
  onUse: () => void
  onReauth: () => void
  onDelete: () => void
  onEdited: () => void
}) {
  const [editing, setEditing] = useState(false)
  const reduce = useReducedMotion()
  const live = isLive(profile)
  const switchable = !profile.active && !busy

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: index * 0.035, ease: EASE_OUT }}
      // The whole row is the switch: pick an account the way you pick a
      // radio option. Menu and dialog clicks stop short of it.
      onClick={() => switchable && onUse()}
      onKeyDown={(e) => {
        if (switchable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          onUse()
        }
      }}
      role={profile.active ? undefined : 'button'}
      tabIndex={profile.active ? undefined : 0}
      aria-label={profile.active ? undefined : `Switch to ${displayName(profile)}`}
      className={cn(
        'group flex items-center gap-4 px-4 py-3 transition-colors',
        live ? 'bg-white/[0.05]' : 'hover:bg-white/[0.02]',
        switchable && 'cursor-pointer'
      )}
    >
      <SwitchDot profile={profile} busy={busy} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'truncate text-sm transition-colors',
            live ? 'font-medium' : 'font-normal text-muted-foreground group-hover:text-foreground'
          )}
        >
          {displayName(profile)}
        </span>
        {profile.duplicate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning-light" size="sm">
                duplicate
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              Two saved accounts share this login. Remove one.
            </TooltipContent>
          </Tooltip>
        )}
        {switchable && (
          <span className="shrink-0 text-xs text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
            Click to switch
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${displayName(profile)}`}
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil />
              Edit account
            </DropdownMenuItem>
            {billingUrl && (
              <DropdownMenuItem onSelect={() => window.aliax.openExternal(billingUrl)}>
                <CreditCard />
                Manage or cancel plan
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              Remove from Aliax
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        {report?.plan && <PlanLine plan={report.plan} now={now} />}
        {report?.expired ? (
          <ExpiredLine onReauth={onReauth} />
        ) : (
          report?.rateLimit && <RateLimitLine rl={report.rateLimit} now={now} />
        )}
      </div>

      <BankedResets count={report?.banked} />
      <UsageBlock report={report} now={now} slots={slots} />

      {/* Dialog clicks bubble back through the portal; keep them off the row. */}
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <EditAccountDialog
          open={editing}
          onOpenChange={setEditing}
          serviceId={serviceId}
          profile={profile}
          onSaved={onEdited}
        />
      </span>
    </motion.li>
  )
}

function ServicePanel({
  service,
  usage,
  busy,
  now,
  onCapture,
  onAdd,
  onUse,
  onReauth,
  onDelete,
  onRefresh
}: {
  service: ServiceView
  usage?: UsageReport[]
  busy: string | null
  now: number
  onCapture: () => void
  onAdd: () => void
  onUse: (name: string) => void
  onReauth: (name: string, email?: string) => void
  onDelete: (name: string) => void
  onRefresh: () => void
}) {
  // Widen only as far as the busiest row in this service needs.
  const slots = Math.min(
    MAX_SLOTS,
    Math.max(BASE_SLOTS, ...(usage ?? []).map((r) => groupWindows(r.windows).length), BASE_SLOTS)
  )
  return (
    <section className="panel overflow-hidden">
      <header className="flex h-16 items-center gap-3 px-4">
        <IconTile variant="frame" style={{ color: SERVICE_TINT[service.id] }}>
          <BrandMark id={service.id} className={service.installed ? '' : 'opacity-40'} />
        </IconTile>
        <h2
          className={cn(
            'text-[15px] font-semibold tracking-tight',
            !service.installed && 'text-muted-foreground'
          )}
        >
          {service.name}
        </h2>
        {!service.installed && (
          <Badge variant="secondary" size="lg">
            Not installed
          </Badge>
        )}

        {service.installed && (
          <div className="ml-auto flex items-center gap-1.5">
            {service.canSaveCurrent && (
              <Button size="sm" disabled={busy === 'capture'} onClick={onCapture}>
                <Download />
                Save current
              </Button>
            )}
            {service.canAddAccount && (
              <Button variant="outline" size="sm" onClick={onAdd}>
                <Plus />
                Add account
              </Button>
            )}
          </div>
        )}
      </header>

      {service.notice && (
        <div className="px-4 pb-3">
          <Alert variant="warning">
            <CircleAlert />
            <AlertDescription>{service.notice}</AlertDescription>
          </Alert>
        </div>
      )}

      {service.profiles.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {service.profiles.map((p, i) => (
            <ProfileRow
              key={p.name}
              serviceId={service.id}
              profile={p}
              index={i}
              now={now}
              slots={slots}
              billingUrl={service.billingUrl}
              report={usage?.find((r) => r.profileName === p.name)}
              busy={busy === `use:${p.name}`}
              onUse={() => onUse(p.name)}
              onReauth={() => onReauth(p.name, p.email)}
              onDelete={() => onDelete(p.name)}
              onEdited={onRefresh}
            />
          ))}
        </ul>
      ) : (
        service.installed && (
          <div className="border-t border-border px-4 py-7 text-center">
            <p className="text-sm text-muted-foreground">No accounts saved yet.</p>
            <p className="pt-1 text-xs text-muted-foreground/70">
              Add one, or save the account already signed in.
            </p>
          </div>
        )
      )}
    </section>
  )
}

export function SectionSkeleton() {
  return (
    <section className="panel overflow-hidden">
      <div className="flex h-16 items-center gap-3 px-4">
        <Skeleton className="size-10 rounded-lg" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex items-center gap-4 border-t border-border px-4 py-5">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3.5 w-48" />
        <div className="ml-auto grid w-[21.5rem] grid-cols-2 gap-6">
          <Skeleton className="h-1.5 w-full self-center" />
          <Skeleton className="h-1.5 w-full self-center" />
        </div>
      </div>
    </section>
  )
}

export function AccountsView({
  views,
  usage,
  busy,
  onCapture,
  onAdd,
  onReauth,
  onUse,
  onDelete,
  onRefresh
}: {
  views: ServiceView[]
  usage: Partial<Record<ServiceId, UsageReport[]>>
  busy: string | null
  onCapture: (serviceId: ServiceId) => void
  onAdd: (serviceId: ServiceId) => void
  onReauth: (serviceId: ServiceId, email?: string) => void
  onUse: (serviceId: ServiceId, name: string) => void
  onDelete: (serviceId: ServiceId, name: string) => void
  onRefresh: () => void
}) {
  const now = useNow()
  return (
    <div className="space-y-4">
      {views.map((s) => (
        <ServicePanel
          key={s.id}
          service={s}
          usage={usage[s.id]}
          now={now}
          busy={
            busy === `capture:${s.id}`
              ? 'capture'
              : busy?.startsWith(`use:${s.id}:`)
                ? `use:${busy.slice(`use:${s.id}:`.length)}`
                : null
          }
          onCapture={() => onCapture(s.id)}
          onAdd={() => onAdd(s.id)}
          onUse={(name) => onUse(s.id, name)}
          onReauth={(_name, email) => onReauth(s.id, email)}
          onDelete={(name) => onDelete(s.id, name)}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  )
}
