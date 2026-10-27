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
                onMenu={noop}
              />
            ))}
          </div>
        ))}
      </div>
      <BatchFoot batch={FIXTURE_BATCH} titleOf={() => undefined} onSave={async () => {}} onStop={async () => {}} />
    </div>
  );
}
