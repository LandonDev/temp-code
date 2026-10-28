import { registry } from "../lib/connection";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Progress } from "../components/ui/progress";
import { TOOLTIP_CLOSE_DELAY, TOOLTIP_DELAY } from "../components/ui/tooltip";
import { HarnessIcon } from "./HarnessIcon";
import { useSlowClock } from "../lib/turnClock";
import { sessionStore, useSessionMeta } from "../lib/tcserver/store";
import { useAccounts } from "../stores/accounts";
import { ACCOUNT_PROVIDERS, type AccountProvider } from "@server/shared/accounts";
import { PROVIDER_NAME, isLow, meterFor, untilShort, untilWords, type UsageMeter as Meter } from "@server/shared/usageMeter";

/**
 * The rail's foot: one row per provider with accounts, the pooled share left
 * across every account routing could pick and when more comes back. No
 * account is named; the popover lists the windows. It reads the accounts of
 * the active thread's host, else this machine's, and moves on the accounts
 * push alone.
 */
export function UsageMeter({ sessionId }: { sessionId?: string }) {
  const now = useSlowClock(true);
  const meta = useSessionMeta(sessionId);
  const environmentId =
    (sessionId ? sessionStore.environmentOf(sessionId) : undefined) ??
    meta?.environmentId ??
    registry.primary().environmentId;
  const { snapshot } = useAccounts(environmentId);
  const rows = ACCOUNT_PROVIDERS.flatMap((provider) => {
    const meter = meterFor(provider, snapshot, now);
    return meter ? [{ provider, meter }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div aria-label="Usage" className="flex shrink-0 flex-col gap-px px-2 pb-2">
      {rows.map(({ provider, meter }) => (
        <MeterRow key={provider} provider={provider} meter={meter} now={now} />
      ))}
    </div>
  );
}

interface MeterProps {
  provider: AccountProvider;
  meter: Meter;
  now: number;
}

const percent = (share: number): number => Math.round(share * 100);
const future = (at: number | null, now: number): at is number => at !== null && at > now;
const fillOf = (share: number | null) => (isLow(share) ? "warning" : "muted");

function MeterRow(props: MeterProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={TOOLTIP_DELAY}
        closeDelay={TOOLTIP_CLOSE_DELAY}
        render={<MeterRowView {...props} />}
      />
      <PopoverContent side="right" align="end" className="w-64 gap-3 p-3">
        <MeterDetails {...props} />
      </PopoverContent>
    </Popover>
  );
}

function rowLabel({ provider, meter, now }: MeterProps): string {
  const name = `${PROVIDER_NAME[provider]} usage`;
  if (meter.share === null) return `${name}, no report yet`;
  const parts = [name, `${percent(meter.share)}% left`];
  if (meter.limited) parts.push(future(meter.limited.until, now) ? `limited for ${untilWords(meter.limited.until, now)}` : "limited");
  else if (future(meter.resetsAt, now)) parts.push(`refills in ${untilWords(meter.resetsAt, now)}`);
  return parts.join(", ");
}

/** The rail row: glyph, the pooled bar, then the refill time or the limit. */
export function MeterRowView({ provider, meter, now, ...trigger }: MeterProps & React.ComponentProps<"button">) {
  return (
    <Button
      variant="ghost"
      className="h-9 w-full justify-start gap-2 rounded-md px-2.5 font-normal"
      aria-label={rowLabel({ provider, meter, now })}
      data-provider={provider}
      {...trigger}
    >
      <HarnessIcon harness={provider} className="size-4 shrink-0 text-muted-foreground" />
      <Progress
        value={meter.share === null ? null : percent(meter.share)}
        fill={fillOf(meter.share)}
        aria-label={`${PROVIDER_NAME[provider]} usage left`}
        className="w-20 shrink-0"
      />
      {meter.limited ? (
        <span className="flex min-w-0 gap-2 text-[12px] text-warning tabular-nums">
          <span>Limited</span>
          {future(meter.limited.until, now) ? <span>{untilShort(meter.limited.until, now)}</span> : null}
        </span>
      ) : future(meter.resetsAt, now) ? (
        <span className="min-w-0 truncate text-[12px] text-muted-foreground tabular-nums">
          in {untilShort(meter.resetsAt, now)}
        </span>
      ) : null}
    </Button>
  );
}

const roomWords = (n: number): string =>
  n === 0 ? "No account with room" : n === 1 ? "1 account with room" : `${n} accounts with room`;

/** The popover's body: the provider's share, one row per usage window, and how many accounts have room. */
export function MeterDetails({ provider, meter, now }: MeterProps) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium text-foreground">{PROVIDER_NAME[provider]}</span>
        {meter.share !== null ? (
          <span className="text-muted-foreground tabular-nums">{percent(meter.share)}% left</span>
        ) : null}
      </div>
      {meter.share === null ? (
        <p className="text-[12px] text-muted-foreground">No usage reported yet</p>
      ) : (
        <>
          {meter.windows.map((w) => (
            <div key={w.label} data-window={w.label} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] text-foreground">{w.name}</span>
                {future(w.resetsAt, now) ? (
                  <span className="text-[12px] text-muted-foreground tabular-nums">in {untilShort(w.resetsAt, now)}</span>
                ) : null}
                <span className="ms-auto text-[13px] text-foreground tabular-nums">{percent(w.share)}%</span>
              </div>
              <Progress value={percent(w.share)} fill={fillOf(w.share)} aria-label={`${w.name} left`} />
            </div>
          ))}
          {meter.limited ? (
            <p className="mt-1 text-[12px] text-warning">
              {future(meter.limited.until, now) ? `Limited for ${untilShort(meter.limited.until, now)}` : "Limited"}
            </p>
          ) : (
            <p className="mt-1 text-[12px] text-muted-foreground">{roomWords(meter.withRoom)}</p>
          )}
        </>
      )}
    </>
  );
}
