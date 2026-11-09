import type { AddonRow, AddonStatus } from "@shared/contract-addons";
import { MoreHorizontal } from "../../../chrome/icons";
import { RowsMenu } from "../../../chrome/menuRows";
import { PageRow } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { StatusMark } from "../../../components/ui/status";
import { Facts } from "../hosts/Facts";
import { addonFacts, addonMark, addonMenuRows, type AddonMenuPick, type GrantKnown } from "./addonWords";

/**
 * One add-on on Settings → Add-ons (docs/LAYOUT.md "Settings → Add-ons and
 * Skills"): its name; its state on this host as a `StatusMark`; one comma
 * run of where it applies, its hosts, its grant and the thread that wrote
 * it, 4px under; a red line for what the host refused. The switch and the ⋯
 * sit at its end over the row's open control, which opens Edit….
 */
export function AddonRowView({
  row,
  status,
  grant,
  unread,
  workspaceName,
  web,
  blocked,
  error,
  onToggle,
  onPick,
}: {
  row: AddonRow;
  status: AddonStatus | undefined;
  grant: GrantKnown;
  /** why the grants are not known yet, when they are not */
  unread?: string;
  workspaceName: string | null;
  web: boolean;
  blocked: boolean;
  error?: string;
  onToggle: (on: boolean) => Promise<unknown>;
  onPick: (pick: AddonMenuPick) => void;
}) {
  const mark = addonMark(row, status, grant);
  const facts = addonFacts(row, mark, grant, workspaceName);
  return (
    <PageRow
      data-addon={row.name}
      title={row.name}
      description={
        <>
          {/* A failure's reason is read whole: the detail wraps under itself instead of being cut. */}
          <span className="flex min-w-0">
            <StatusMark
              state={mark.state}
              word={mark.word}
              detail={mark.detail}
              className="min-w-0 **:data-[slot=status-detail]:break-words **:data-[slot=status-detail]:whitespace-normal"
            />
          </span>
          <span className="mt-1 block">
            <Facts parts={facts} />
          </span>
        </>
      }
      error={error}
      onOpen={() => onPick("edit")}
      openLabel={`Edit ${row.name}`}
      openDisabled={blocked}
    >
      <SettingSwitch label={row.name} on={row.enabled} disabled={blocked} onChange={onToggle} />
      <RowsMenu
        label={`${row.name} actions`}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={`${row.name} actions`} disabled={blocked} className="text-muted-foreground">
            <MoreHorizontal />
          </Button>
        }
        rows={() => addonMenuRows(row, grant, { web, unread })}
        onPick={(id) => onPick(id as AddonMenuPick)}
        align="end"
      />
    </PageRow>
  );
}
