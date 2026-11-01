import { ChevronDown, MoreHorizontal, Plus } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { SplitShell } from "../SplitShell";
import { BatchFoot } from "./BatchFoot";
import { FIXTURE_BATCH, fixtureGroups } from "./boardFixture";
import { MasterRowView } from "./MasterRow";

/**
 * The board drawn from boardFixture.ts with no store, for `bun run
 * ui:preview` and the dom test that keeps the fixture honest. Rendered by
 * nothing in the app.
 */

const noop = () => {};
const noHost = () => null;

export function BoardPreview() {
  return (
    <div className="flex flex-col bg-background">
      <div className="px-2 pt-1 pb-3">
        {fixtureGroups().map((group) => (
          <div key={group.id} data-group={group.id}>
            <h3 className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground" data-group-header={group.id}>
              {group.label}
            </h3>
            {group.rows.map((row) => (
              <MasterRowView
                key={row.meta.id}
                meta={row.meta}
                digest={row.digest}
                agents={row.agents}
                landed={row.landed}
                host={null}
                hostGlyph={noHost}
                onOpen={noop}
                menu={{ rowsFor: () => [], onPick: noop, onOpenChange: noop }}
              />
            ))}
          </div>
        ))}
      </div>
      <BatchFoot batch={FIXTURE_BATCH} titleOf={() => undefined} onSave={async () => {}} onStop={async () => {}} />
    </div>
  );
}

/** The master view's two states for `ui:preview`: an empty batch is the
 *  transcript alone; with children the board stands beside it. The chat is
 *  a stand-in for the transcript and composer. */
export function MasterPreview({ empty = false }: { empty?: boolean }) {
  const chat = (
    <div className="flex flex-1 flex-col justify-end gap-3 p-6 text-sm text-foreground">
      <p className="max-w-[65ch]">The batch writes the gate, release and publish steps once its first thread lands.</p>
      <div className="h-24 rounded-lg border border-border bg-card" />
    </div>
  );
  const actions = (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Batch actions">
        <MoreHorizontal />
      </Button>
      <Button variant="ghost" size="sm">
        <Plus />
        Thread
        <ChevronDown className="text-muted-foreground" />
      </Button>
    </>
  );
  return (
    <div className="flex bg-background" style={{ width: 1100, height: 560 }}>
      <SplitShell board={<BoardPreview />} chat={chat} hasBoard={!empty} collapsed={false} onToggleChat={noop} title="iOS batch 2" actions={actions} />
    </div>
  );
}
