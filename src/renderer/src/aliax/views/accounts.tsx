import { useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  Clock,
  CreditCard,
  Download,
  KeyRound,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { PROVIDER_OF, type AccountProvider, type MintProgress, type MintState, type PeerState } from '@shared/accounts'
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

const DAY_MS = 86_400_000
/** The last 30 days of a one-year token: time to make a new one. */
export const STATIC_WARN_MS = 30 * DAY_MS

const daysUntil = (t: number, now: number): number => Math.ceil((t - now) / DAY_MS)
const shortDay = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const agoLabel = (t: number, now: number): string => {
  const mins = Math.max(0, Math.round((now - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** The host that refreshes an account, as a row sees it. */
export interface OwnerView {
  name: string
  connected: boolean
}

const stop = (fn: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation()
  fn()
}

/**
 * Where this account's sign-in lives and how long it lasts. A one-year token
 * says when it lapses: amber inside its last 30 days, a button once it has.
 * A copy another host refreshes names that host and the last sync, and says
 * plainly when the host is out of reach and the copy has run out.
 */
function OwnerLine({
  profile,
  report,
  owner,
  mint,
  now,
  onSetupToken,
  onSync
}: {
  profile: ProfileView
  report?: UsageReport
  owner: OwnerView | null
  /** A one-year token mint under way or waiting on the user, for this row. */
  mint?: MintState
  now: number
  onSetupToken: () => void
  onSync: () => void
}) {
  const lapsed = report?.expired === true || (profile.expiresAt !== undefined && profile.expiresAt <= now)
  const amber = 'flex items-center gap-1.5 text-[11px] text-ax-warning transition-colors hover:text-ax-warning/80'
  const quiet = 'flex items-center gap-1.5 text-[11px] text-muted-foreground'
  if (mint?.state === 'minting') {
    return (
      <span className={quiet}>
        <Loader variant="dots" size={12} />
        Making a one-year token
      </span>
    )
  }
  if (mint) {
    const verb = profile.static ? 'renew its one-year token' : 'make its one-year token'
    return (
      <button type="button" onClick={stop(onSetupToken)} className={amber}>
        <KeyRound className="size-3 shrink-0" />
        <span>
          {mint.state === 'needs-sign-in' ? `Sign in to ${verb}` : `Could not ${verb}${mint.detail ? `: ${mint.detail}` : ''}`} ·{' '}
          <span className="underline underline-offset-2">{mint.state === 'needs-sign-in' ? 'Sign in' : 'Retry'}</span>
        </span>
      </button>
    )
  }
  if (profile.static) {
    const days = profile.expiresAt !== undefined ? daysUntil(profile.expiresAt, now) : null
    if (lapsed || (days !== null && days * DAY_MS <= STATIC_WARN_MS)) {
      return (
        <button type="button" onClick={stop(onSetupToken)} className={amber}>
          <KeyRound className="size-3 shrink-0" />
          <span>
            {lapsed ? 'One-year token lapsed' : `One-year token lapses in ${days} day${days === 1 ? '' : 's'}`} ·{' '}
            <span className="underline underline-offset-2">Make a new one</span>
          </span>
        </button>
      )
    }
    return (
      <span className={quiet}>
        <KeyRound className="size-3 shrink-0" />
        One-year token{profile.expiresAt !== undefined && ` · lapses ${shortDay(profile.expiresAt)}`}
      </span>
    )
  }
  if (!owner) return null
  if (lapsed) {
    const since = profile.expiresAt !== undefined ? ` ${agoLabel(profile.expiresAt, now)}` : ''
    return (
      <button type="button" onClick={stop(onSync)} className={amber}>
        <CircleAlert className="size-3 shrink-0" />
        <span>
          {owner.connected ? `Waiting for a fresh token from ${owner.name}` : `${owner.name} is unreachable · token lapsed${since}`} ·{' '}
          <span className="underline underline-offset-2">Retry</span>
        </span>
      </button>
    )
  }
  return (
    <span className={quiet}>
      <RefreshCw className="size-3 shrink-0" />
      Refreshed by {owner.name}
      {profile.syncedAt !== undefined && ` · synced ${agoLabel(profile.syncedAt, now)}`}
    </span>
  )
}

/** Which host refreshes new sign-ins of a service: this machine, or one it holds an admin key for. */
function HomeControl({
  home,
  environments,
  localName,
  onSetHome
}: {
  home: string | undefined
  environments: { id: string; name: string }[]
  localName: string
  onSetHome: (id: string | null) => void
}) {
  const current = home ? (environments.find((e) => e.id === home)?.name ?? home) : localName
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          Refreshed by {current}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onSetHome(null)}>{localName}</DropdownMenuItem>
        {environments.map((e) => (
          <DropdownMenuItem key={e.id} onSelect={() => onSetHome(e.id)}>
            {e.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  owner,
  mint,
  onUse,
  onReauth,
  onDelete,
  onEdited,
  onSetupToken,
  onSync
}: {
  serviceId: ServiceId
  profile: ProfileView
  report?: UsageReport
  busy: boolean
  index: number
  now: number
  slots: number
  billingUrl?: string
  /** The host that refreshes this account when it is not this machine. */
  owner: OwnerView | null
  mint?: MintState
  onUse: () => void
  onReauth: () => void
  onDelete: () => void
  onEdited: () => void
  onSetupToken: () => void
  onSync: () => void
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
            {serviceId === 'claude-code' && (
              <DropdownMenuItem onSelect={onSetupToken} disabled={mint?.state === 'minting'}>
                <KeyRound />
                {profile.static ? 'New one-year token' : 'Replace with a one-year token'}
              </DropdownMenuItem>
            )}
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
        {profile.static || owner || mint ? (
          <OwnerLine profile={profile} report={report} owner={owner} mint={mint} now={now} onSetupToken={onSetupToken} onSync={onSync} />
        ) : (
          report?.expired && <ExpiredLine onReauth={onReauth} />
        )}
        {!report?.expired && report?.rateLimit && <RateLimitLine rl={report.rateLimit} now={now} />}
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
  home,
  peers,
  environments,
  localName,
  onCapture,
  onAdd,
  onUse,
  onReauth,
  onDelete,
  onRefresh,
  onSetupToken,
  onConvertAll,
  mint,
  onSetHome,
  onSync
}: {
  service: ServiceView
  usage?: UsageReport[]
  busy: string | null
  now: number
  /** The environment new sign-ins of this service are handed to; undefined means this machine. */
  home: string | undefined
  peers: Record<string, PeerState>
  environments: { id: string; name: string }[]
  localName: string
  onCapture: () => void
  onAdd: () => void
  onUse: (name: string) => void
  onReauth: (name: string, email?: string) => void
  onDelete: (name: string) => void
  onRefresh: () => void
  onSetupToken: (identity: { name: string; email?: string }) => void
  onConvertAll: () => void
  /** One-year token mints under way (Claude only). */
  mint?: MintProgress
  onSetHome: (environmentId: string | null) => void
  onSync: (environmentId: string) => void
}) {
  const ownerFor = (p: ProfileView): OwnerView | null => {
    if (!p.owner || p.static) return null
    const env = environments.find((e) => e.id === p.owner)
    return { name: env?.name ?? p.owner, connected: peers[p.owner]?.connected ?? false }
  }
  // Rows a Convert all would touch: not yet a one-year token, or one inside its last 30 days.
  const convertible = service.profiles.filter((p) => !p.static || (p.expiresAt !== undefined && p.expiresAt - now <= STATIC_WARN_MS)).length
  const run = mint?.run ?? null
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
            {environments.length > 0 && service.id !== 'cursor' && (
              <HomeControl home={home} environments={environments} localName={localName} onSetHome={onSetHome} />
            )}
            {service.id === 'claude-code' && (run || convertible > 0) && (
              <Button variant="outline" size="sm" disabled={run !== null} onClick={onConvertAll}>
                {run ? <Loader variant="dots" size={14} /> : <KeyRound />}
                {run ? `Converting ${Math.min(run.done + 1, run.total)} of ${run.total}` : convertible === service.profiles.length ? 'Convert all to one-year tokens' : `Convert ${convertible} to one-year tokens`}
              </Button>
            )}
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
              owner={ownerFor(p)}
              mint={mint?.rows[p.name]}
              report={usage?.find((r) => r.profileName === p.name)}
              busy={busy === `use:${p.name}`}
              onUse={() => onUse(p.name)}
              onReauth={() => onReauth(p.name, p.email)}
              onDelete={() => onDelete(p.name)}
              onEdited={onRefresh}
              onSetupToken={() => onSetupToken({ name: p.name, email: p.email })}
              onSync={() => p.owner && onSync(p.owner)}
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
  onRefresh,
  homes,
  peers,
  environments,
  localName,
  onSetupToken,
  onConvertAll,
  mint,
  onSetHome,
  onSync
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
  /** Per provider, the host new sign-ins are handed to (accounts snapshot `homes`). */
  homes: Partial<Record<AccountProvider, string>>
  /** The account-sync links this machine holds, by environment id. */
  peers: Record<string, PeerState>
  /** Those hosts, named. */
  environments: { id: string; name: string }[]
  localName: string
  onSetupToken: (serviceId: ServiceId, identity: { name: string; email?: string }) => void
  /** Every Claude account not yet holding a one-year token, in one go. */
  onConvertAll: () => void
  /** One-year token mints under way (the Claude snapshot's `mint`). */
  mint?: MintProgress
  onSetHome: (provider: AccountProvider, environmentId: string | null) => void
  onSync: (environmentId: string) => void
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
          home={homes[PROVIDER_OF[s.id]]}
          peers={peers}
          environments={environments}
          localName={localName}
          onSetupToken={(identity) => onSetupToken(s.id, identity)}
          onConvertAll={onConvertAll}
          mint={s.id === 'claude-code' ? mint : undefined}
          onSetHome={(id) => onSetHome(PROVIDER_OF[s.id], id)}
          onSync={onSync}
        />
      ))}
    </div>
  )
}
