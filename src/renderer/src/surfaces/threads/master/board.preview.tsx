import { HostGlyph } from "../../../chrome/HostGlyph";
import { MoreHorizontal, Plus } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { SplitShell } from "../SplitShell";
import { BatchFoot } from "./BatchFoot";
import { FIXTURE_BATCH, FIXTURE_ROWS, fixtureGroups, TASK_BAR_ROWS, TASK_BAR_WIDTH_ROWS, type FixtureRow } from "./boardFixture";
import { MasterRowView } from "./MasterRow";

/**
 * The board drawn from boardFixture.ts with no store, for `bun run
 * ui:preview` and the dom test that keeps the fixture honest. Rendered by
 * nothing in the app.
 */

const noop = () => {};
/** The far row's host glyph (drawn once the window knows two hosts). */
const hostGlyph = (environmentId: string) => (environmentId === "local" ? null : <HostGlyph environmentId={environmentId} className="shrink-0" />);
const tally = `${FIXTURE_ROWS.filter((r) => r.meta.status === "idle").length}/${FIXTURE_ROWS.length}`;

export function BoardPreview({ rows = FIXTURE_ROWS, foot = true }: { rows?: readonly FixtureRow[]; foot?: boolean }) {
  return (
    <div className="flex flex-col bg-background">
      <div className="px-1 pt-1 pb-2">
      <div className="@container" data-board-pane>
        {fixtureGroups(rows).map((group, i) => (
          <div key={group.id} data-group={group.id}>
            <h3 className={`flex ${i === 0 ? "h-6" : "h-8"} items-end px-2 pb-1 text-xs leading-4 font-medium text-muted-foreground`} data-group-header={group.id}>
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
                hostGlyph={hostGlyph}
                onOpen={noop}
                menu={{ rowsFor: () => [], onPick: noop, onOpenChange: noop }}
                tasksChoice={row.tasksChoice}
                onTasksChoice={noop}
              />
            ))}
          </div>
        ))}
      </div>
      </div>
      {foot ? <BatchFoot batch={FIXTURE_BATCH} titleOf={() => undefined} onSave={async () => {}} onStop={async () => {}} /> : null}
    </div>
  );
}

/** The task bar's rows alone at a board width (`ui:preview
 *  …board.preview.tsx#TaskBarPreview --props '{"width":420}'`). */
export function TaskBarPreview({ width = 420 }: { width?: number }) {
  return (
    <div style={{ width }}>
      <BoardPreview rows={TASK_BAR_ROWS} foot={false} />
    </div>
  );
}

/** Three rows whose task lists differ in width: one bar width for all, 35%
 *  of the pane (`ui:preview …board.preview.tsx#TaskBarWidthPreview --props '{"width":900}'`). */
export function TaskBarWidthPreview({ width = 560 }: { width?: number }) {
  return (
    <div style={{ width }}>
      <BoardPreview rows={TASK_BAR_WIDTH_ROWS} foot={false} />
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
      <Button variant="ghost" size="icon-sm" aria-label="Add thread">
        <Plus />
      </Button>
    </>
  );
  return (
    <div className="flex bg-background" style={{ width: 1100, height: 560 }}>
      <SplitShell board={<BoardPreview />} chat={chat} hasBoard={!empty} collapsed={false} onToggleChat={noop} title="iOS batch 2" detail={tally} actions={actions} />
    </div>
  );
}
