import { Fragment, useMemo, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import type { OpenFileFn } from "../../../lib/search";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { agentSections, type AgentSection } from "../../../lib/threads/agents";
import { AgentDetail } from "./AgentDetail";
import { AgentRow } from "./AgentRow";
import { useFleetModel } from "./useFleetModel";

/** What one row of the sections is drawn from. */
export type SectionRow = {
  meta: SessionMeta;
  depth: number;
  /** The heading drawn above the row's section, or null with none drawn. */
  heading: string | null;
  selected: boolean;
  onOpen: () => void;
  onOpenSession?: (sessionId: string) => void;
};

const storeRow = (row: SectionRow) => (
  <AgentRow
    agent={row.meta}
    heading={row.heading}
    depth={row.depth}
    selected={row.selected}
    onOpen={row.onOpen}
    onOpenSession={row.onOpenSession}
  />
);

/**
 * The agents in the board's sections: Needs you, Working, Queued, Done,
 * each top agent by its own state with its descendants indented under it.
 * A heading (12px medium, muted, on a 24px line at the rows' glyph edge)
 * is drawn only where two sections meet; with one, every row says its own
 * word. Sections sit 16px apart, rows 2px; the list's inset puts the glyph
 * column 12px from the panel's edge, as the Activity section's. Nothing
 * here moves (docs/DESIGN.md: list rows animate nothing). `row` draws one
 * row; by default from the store (`AgentRow`), a fixture passes its own.
 * `emptyLine` is the empty state's second line (a master's: its batch
 * threads are on the board, never here).
 */
export function FleetSectionsView({
  sections,
  selectedId = null,
  onOpen,
  onOpenSession,
  row = storeRow,
  emptyLine,
}: {
  sections: readonly AgentSection[];
  emptyLine?: string;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onOpenSession?: (sessionId: string) => void;
  row?: (row: SectionRow) => ReactNode;
}) {
  if (sections.length === 0) {
    return (
      <Empty className="p-6">
        <EmptyHeader>
          <EmptyTitle>No subagents</EmptyTitle>
          {emptyLine ? <EmptyDescription>{emptyLine}</EmptyDescription> : null}
        </EmptyHeader>
      </Empty>
    );
  }
  const headings = sections.length > 1;
  const draw = (meta: SessionMeta, depth: number, heading: string | null) => (
    <Fragment key={meta.id}>
      {row({ meta, depth, heading, selected: selectedId === meta.id, onOpen: () => onOpen(meta.id), onOpenSession })}
    </Fragment>
  );
  return (
    <div className="flex flex-col gap-4 px-1 py-3" data-slot="agents-section">
      {sections.map((section) => {
        const heading = headings ? section.label : null;
        return (
          <section key={section.id} aria-label={section.label} className="flex flex-col gap-0.5" data-section={section.id}>
            {heading ? <h3 className="flex h-6 items-center px-2 text-xs font-medium text-muted-foreground">{heading}</h3> : null}
            {section.nodes.map((node) => (
              <Fragment key={node.meta.id}>
                {draw(node.meta, 0, heading)}
                {node.descendants.map((d) => draw(d.meta, d.depth, heading))}
              </Fragment>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The subagent rows: the right panel's Agents section (surfaces/RightPanel.tsx),
 * with the agent detail sheet over the pane when a row is open. Only the
 * detail has an exit.
 */
export function FleetList({
  sessionId,
  parentCwd,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
  emptyLine,
}: {
  sessionId: string;
  parentCwd: string;
  /** The empty state's second line (FleetSectionsView). */
  emptyLine?: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  const fleet = useFleetModel(sessionId);
  const { tree, detailId } = fleet;
  const sections = useMemo(() => agentSections(tree), [tree]);

  return (
    <>
      {sections.length === 0 ? (
        <FleetSectionsView sections={sections} onOpen={fleet.setDetailId} emptyLine={emptyLine} />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <FleetSectionsView sections={sections} selectedId={detailId} onOpen={fleet.setDetailId} onOpenSession={onOpenSession} />
        </div>
      )}
      <AnimatePresence>
        {detailId ? (
          <AgentDetail
            key={detailId}
            agentId={detailId}
            parentCwd={parentCwd}
            onClose={() => fleet.setDetailId(null)}
            onOpenSession={onOpenSession}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
