import { PROVIDER_OF, type AccountHeadroom, type AccountProvider, type MintProgress, type PeerState } from "@shared/accounts";
import type { ProfileView, ServiceId, ServiceView, UsageReport } from "aliax-core/shared/types";
import { HarnessIcon } from "@renderer/chrome/HarnessIcon";
import { MoreHorizontal } from "@renderer/chrome/icons";
import { PageSection } from "@renderer/components/page";
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
import { Empty, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import type { HarnessId } from "@renderer/lib/session";
import { useNow } from "@aliax/lib/accounts";
import { AccountRow, barColumns } from "./accounts/row";
import { STATIC_WARN_MS, type OwnerView, type RowAction } from "./accounts/rowLine";

const HARNESS: Record<ServiceId, HarnessId> = { "claude-code": "claude", codex: "codex", cursor: "cursor" };

export interface AccountsActions {
  onCapture: (serviceId: ServiceId) => void;
  onAdd: (serviceId: ServiceId) => void;
  onReauth: (serviceId: ServiceId, email?: string) => void;
  onUse: (serviceId: ServiceId, name: string) => void;
  onDelete: (serviceId: ServiceId, name: string) => void;
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
      <DropdownMenuSubContent size="sm">
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

function ProviderSection({ service, props, now }: { service: ServiceView; props: AccountsViewProps; now: number }) {
  const { usage, headroom, busy, homes, peers, environments, localName, mint } = props;
  const reports = usage[service.id];
  const rates = headroom[service.id];
  const claude = service.id === "claude-code";
  const run = claude ? (mint?.run ?? null) : null;
  // Rows a Convert all would touch: not yet a one-year token, or one inside its last 30 days.
  const convertible = claude ? service.profiles.filter((p) => !p.static || (p.expiresAt !== undefined && p.expiresAt - now <= STATIC_WARN_MS)).length : 0;
  const showHome = environments.length > 0 && service.id !== "cursor";
  const menu = service.installed && (service.canSaveCurrent || convertible > 0 || showHome);
  const reportOf = (p: ProfileView) => reports?.find((r) => r.profileName === p.name);
  const columns = barColumns(service.profiles.map((p) => ({ report: reportOf(p), headroom: rates?.[p.name] })));
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
          <HarnessIcon harness={HARNESS[service.id]} className={service.installed ? "size-3.5" : "size-3.5 opacity-50"} />
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
            {service.canAddAccount ? (
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
                    <MoreHorizontal strokeWidth={1.75} />
                  </TooltipTrigger>
                  <TooltipContent>{service.name} actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" size="sm">
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
        <Empty className="py-6">
          <EmptyTitle>No accounts saved</EmptyTitle>
        </Empty>
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
            onRemove={() => props.onDelete(service.id, p.name)}
            onEdited={props.onRefresh}
          />
        ))
      )}
    </PageSection>
  );
}

/** One section per provider, one row per saved account. */
export function AccountsView(props: AccountsViewProps) {
  const live = useNow();
  const now = props.now ?? live;
  return (
    <>
      {props.views.map((s) => (
        <ProviderSection key={s.id} service={s} props={props} now={now} />
      ))}
    </>
  );
}

/** The page's shape while the services load: three sections of two rows. */
export function AccountsSkeleton() {
  return (
    <>
      {[0, 1, 2].map((section) => (
        <div key={section} aria-busy="true" aria-label="Loading" className="flex flex-col">
          <Skeleton className="h-3 w-24" />
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3 py-3">
              <Skeleton className="size-2 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-6 w-[72px]" />
              <Skeleton className="h-6 w-[72px]" />
              <Skeleton className="h-[18px] w-8 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
