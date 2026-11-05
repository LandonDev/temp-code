import { PROVIDER_OF, type AccountHeadroom, type AccountProvider, type MintProgress, type PeerState } from "@shared/accounts";
import type { ProfileView, ServiceId, ServiceView, UsageReport } from "aliax-core/shared/types";
import { HarnessIcon, type MarkId } from "@renderer/chrome/HarnessIcon";
import { MoreHorizontal } from "@renderer/chrome/icons";
import { PageEmpty, PageSection } from "@renderer/components/page";
import { Alert, AlertDescription } from "@renderer/components/ui/alert";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNow } from "@aliax/lib/accounts";
import { AccountRow, barColumns, type BarColumns } from "./accounts/row";
import { UsageCellsSkeleton } from "./accounts/usage";
import { STATIC_WARN_MS, type OwnerView, type RowAction } from "./accounts/rowLine";

/** The mark each section leads with: the harness's, or Meta's vendor mark. */
const HARNESS: Record<ServiceId, MarkId> = { "claude-code": "claude", codex: "codex", cursor: "cursor", meta: "meta", "muse-code": "muse" };

/** Services whose accounts are API keys: added with Add key…, never signed in to, switched or refreshed. */
const KEY_SERVICES = new Set<ServiceId>(["meta"]);

export interface AccountsActions {
  onCapture: (serviceId: ServiceId) => void;
  onAdd: (serviceId: ServiceId) => void;
  /** A key service's Add key…: the page opens AddKeyDialog. */
  onAddKey: (serviceId: ServiceId) => void;
  onReauth: (serviceId: ServiceId, email?: string) => void;
  onUse: (serviceId: ServiceId, name: string) => void;
  /** A row's Remove…: the page owns the confirm, so it outlives the row it removes. */
  onRemove: (serviceId: ServiceId, profile: ProfileView) => void;
  onRefresh: () => void;
  onSetupToken: (serviceId: ServiceId, identity: { name: string; email?: string }) => void;
  /** Every Claude account not yet holding a one-year token, in one go. */
  onConvertAll: () => void;
  onSetHome: (provider: AccountProvider, environmentId: string | null) => void;
  onSync: (environmentId: string) => void;
}

export interface AccountsViewProps extends AccountsActions {
  views: ServiceView[];
  usage: Partial<Record<ServiceId, UsageReport[]>>;
  /** The reports the usage columns are laid out from: the last ones seen, kept
   *  while a Refresh masks `usage` to skeletons, so the columns stay put. */
  layout?: Partial<Record<ServiceId, UsageReport[]>>;
  /** Per service, per account, the gateways' rate-limit picture. */
  headroom: Partial<Record<ServiceId, Record<string, AccountHeadroom>>>;
  /** The action under way, as `use:<service>:<name>` or `capture:<service>`. */
  busy: string | null;
  /** Per provider, the host new sign-ins are handed to (accounts snapshot `homes`). */
  homes: Partial<Record<AccountProvider, string>>;
  /** The account-sync links this machine holds, by environment id. */
  peers: Record<string, PeerState>;
  /** Those hosts, named. */
  environments: { id: string; name: string }[];
  localName: string;
  /** One-year token mints under way (the Claude snapshot's `mint`). */
  mint?: MintProgress;
  /** A fixed clock for previews and tests; live otherwise. */
  now?: number;
}

/** Which host refreshes new sign-ins, as radio rows; `''` is this machine. */
function HomeMenu({ home, environments, localName, onSetHome }: { home: string | undefined; environments: { id: string; name: string }[]; localName: string; onSetHome: (id: string | null) => void }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Refreshed by</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={home ?? ""} onValueChange={(value: string) => onSetHome(value || null)}>
          <DropdownMenuRadioItem value="">{localName}</DropdownMenuRadioItem>
          {environments.map((e) => (
            <DropdownMenuRadioItem key={e.id} value={e.id}>
              {e.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ProviderSection({ service, props, now, columns }: { service: ServiceView; props: AccountsViewProps; now: number; columns: BarColumns }) {
  const { usage, headroom, busy, homes, peers, environments, localName, mint } = props;
  const reports = usage[service.id];
  const rates = headroom[service.id];
  const claude = service.id === "claude-code";
  const run = claude ? (mint?.run ?? null) : null;
  // Rows a Convert all would touch: not yet a one-year token, or one inside its last 30 days.
  const convertible = claude ? service.profiles.filter((p) => !p.static || (p.expiresAt !== undefined && p.expiresAt - now <= STATIC_WARN_MS)).length : 0;
  const keyed = KEY_SERVICES.has(service.id);
  // A key has no refresher: every host holds it, so there is no home to pick.
  const showHome = environments.length > 0 && service.id !== "cursor" && !keyed;
  const menu = service.installed && (service.canSaveCurrent || convertible > 0 || showHome);
  const reportOf = (p: ProfileView) => reports?.find((r) => r.profileName === p.name);
  const ownerFor = (p: ProfileView): OwnerView | null => {
    if (!p.owner || p.static) return null;
    const env = environments.find((e) => e.id === p.owner);
    return { name: env?.name ?? p.owner, connected: peers[p.owner]?.connected ?? false };
  };
  const act = (p: ProfileView, kind: RowAction["kind"]) => {
    if (kind === "token") props.onSetupToken(service.id, { name: p.name, email: p.email });
    else if (kind === "reauth") props.onReauth(service.id, p.email);
    else if (p.owner) props.onSync(p.owner);
  };

  return (
    <PageSection
      title={
        <span className="flex items-center gap-2">
          {HARNESS[service.id] ? <HarnessIcon harness={HARNESS[service.id]!} className={service.installed ? "size-3.5" : "size-3.5 opacity-50"} /> : null}
          {service.name}
        </span>
      }
      description={
        !service.installed ? (
          "Not installed"
        ) : run ? (
          <span className="flex items-center gap-2">
            <Spinner className="size-3" />
            Converting {Math.min(run.done + 1, run.total)} of {run.total} to one-year tokens
          </span>
        ) : undefined
      }
      action={
        service.installed ? (
          <>
            {keyed ? (
              <Button variant="ghost" size="sm" onClick={() => props.onAddKey(service.id)}>
                Add key…
              </Button>
            ) : service.canAddAccount ? (
              <Button variant="ghost" size="sm" onClick={() => props.onAdd(service.id)}>
                Add account
              </Button>
            ) : null}
            {menu ? (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${service.name} actions`} className="text-muted-foreground" />} />}
                  >
                    <MoreHorizontal />
                  </TooltipTrigger>
                  <TooltipContent>{service.name} actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  {service.canSaveCurrent ? (
                    <DropdownMenuItem disabled={busy === `capture:${service.id}`} onClick={() => props.onCapture(service.id)}>
                      Save current account
                    </DropdownMenuItem>
                  ) : null}
                  {convertible > 0 ? (
                    <DropdownMenuItem disabled={run !== null} onClick={props.onConvertAll}>
                      {convertible === service.profiles.length ? "Convert all to one-year tokens" : `Convert ${convertible} to one-year tokens`}
                    </DropdownMenuItem>
                  ) : null}
                  {showHome ? (
                    <HomeMenu home={homes[PROVIDER_OF[service.id]]} environments={environments} localName={localName} onSetHome={(id) => props.onSetHome(PROVIDER_OF[service.id], id)} />
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        ) : undefined
      }
    >
      {service.installed && service.notice ? (
        <Alert variant="warning" className="mb-2">
          <AlertDescription>{service.notice}</AlertDescription>
        </Alert>
      ) : null}
      {!service.installed ? null : service.profiles.length === 0 ? (
        <PageEmpty>{keyed ? "No keys saved" : "No accounts saved"}</PageEmpty>
      ) : (
        service.profiles.map((p) => (
          <AccountRow
            key={p.name}
            serviceId={service.id}
            profile={p}
            report={reportOf(p)}
            headroom={rates?.[p.name]}
            columns={columns}
            now={now}
            owner={ownerFor(p)}
            mint={claude ? mint?.rows[p.name] : undefined}
            billingUrl={service.billingUrl}
            switching={busy === `use:${service.id}:${p.name}`}
            onUse={() => props.onUse(service.id, p.name)}
            onAction={(kind) => act(p, kind)}
            onSetupToken={() => props.onSetupToken(service.id, { name: p.name, email: p.email })}
            onRemove={() => props.onRemove(service.id, p)}
            onEdited={props.onRefresh}
          />
        ))
      )}
    </PageSection>
  );
}

/**
 * One section per provider, one row per saved account, in the page's own
 * container: from 48rem the rows read as one table whose usage columns line
 * up down the whole page, every section included (row.tsx).
 */
export function AccountsView(props: AccountsViewProps) {
  const live = useNow();
  const now = props.now ?? live;
  const reports = props.layout ?? props.usage;
  const columns = barColumns(
    props.views
      .filter((s) => s.installed)
      .flatMap((s) => s.profiles.map((p) => ({ report: reports[s.id]?.find((r) => r.profileName === p.name), headroom: props.headroom[s.id]?.[p.name] }))),
  );
  return (
    <div data-slot="accounts" className="@container/accounts flex flex-col gap-6">
      {props.views.map((s) => (
        <ProviderSection key={s.id} service={s} props={props} now={now} columns={columns} />
      ))}
    </div>
  );
}

/** The page's shape while the services load: three sections of two rows, the usage columns at their table width. */
export function AccountsSkeleton() {
  return (
    <div className="@container/accounts flex flex-col gap-6">
      {[0, 1, 2].map((section) => (
        <div key={section} aria-busy="true" aria-label="Loading" className="flex flex-col">
          {/* PageSection's 20px heading line, then its 8px to the rows. */}
          <div data-slot="heading-skeleton" className="flex h-5 items-center">
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-2 flex flex-col">
            {[0, 1].map((row) => (
              // An AccountRow's shape: the dot, the 20px name over its 16px line, the bars, the switch and ⋯.
              <div key={row} data-slot="account-row-skeleton" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <Skeleton className="size-2 rounded-full" />
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="flex h-5 items-center">
                    <Skeleton className="h-3.5 w-36" />
                  </span>
                  <span className="flex h-4 items-center">
                    <Skeleton className="h-3 w-24" />
                  </span>
                </div>
                <UsageCellsSkeleton cells={3} className="order-last basis-full ps-5 @3xl/accounts:order-none @3xl/accounts:basis-auto @3xl/accounts:ps-0" />
                <span className="flex items-center gap-2">
                  <Skeleton className="h-[18px] w-8 rounded-full" />
                  <Skeleton className="size-7 rounded-md" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
