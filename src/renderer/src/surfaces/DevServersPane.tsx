import { useLayoutEffect } from "react";
import type { DevTarget } from "@server/shared/contract-devservers";
import { DEV_TAB, DockBar } from "../chrome/DockBar";
import { DevServerRow } from "../chrome/DevServerRow";
import { DockFrame } from "../chrome/DockFrame";
import { DevStarter, useDevStarter } from "./DevStarter";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { ItemGroup } from "../components/ui/item";
import { ScrollArea } from "../components/ui/scroll-area";
import { devPane, useDevPane } from "../lib/devPane";
import { serverGroups, shownServer, useDevTab, useDockProject, useLiveDevServers } from "../lib/devServers";
import { findProjectTerminal, selectDockTerminal, withDockOpen, withDockSize } from "../lib/projectTerminal";
import { useProjects } from "../lib/tcserver/workspaces";
import { dockCwdOf, useActivePane, useProject } from "../stores/project";
import { terminals, useTerminals } from "../stores/terminals";
import { DevConsole } from "./DevConsole";

/**
 * The Dev servers pane (docs/box.md "Dev servers on the box"): the bottom
 * dock's other occupant, under the same bar as the terminals (its Dev
 * servers tab is the one picked) and at the dock's height. The starter
 * runs a target for the thread on screen; below it, one row per dev server
 * live on a host right now (a running Dev Server run, or a port a thread
 * opened that still listens) under the thread it belongs to; a row leaves
 * the moment its host drops it. The picked row's console fills
 * the rest.
 */
export function DevServersPane({
  onSizePaint,
  onSizeCommit,
  onShowTerminal,
}: {
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  /** Absent at /ui, where there is no terminal to switch to: the bar then has no terminal tabs and no New terminal. */
  onShowTerminal?: () => void;
}) {
  const size = useDevPane((s) => s.size);
  const picked = useDevPane((s) => s.picked);
  const servers = useLiveDevServers();
  const shown = shownServer(servers, picked);
  const { cwd, dock } = useCurrentDock();
  const dev = useDevTab(cwd);
  const project = useDockProject(cwd);
  const starter = useDevStarter(project?.id ?? null);
  const activeCwd = useActivePane().active?.cwd;

  // One height for the dock: the pane takes the terminals' before paint.
  useLayoutEffect(() => {
    if (dock && dock.size !== size) devPane.size(dock.size);
  }, [dock, size]);

  return (
    <DockFrame
      data-dev-servers-pane=""
      size={size}
      focused={false}
      label="Resize dev servers"
      onFocus={noop}
      onSizePaint={onSizePaint}
      onSizeCommit={(next) => {
        onSizeCommit(next);
        terminals.updateDock(cwd, (d) => withDockSize(d, next, { width: window.innerWidth, height: window.innerHeight }));
      }}
    >
      <DockBar
        terminals={onShowTerminal ? (dock?.pane.files ?? EMPTY_FILES) : EMPTY_FILES}
        active={DEV_TAB}
        dev={dev ?? { count: servers.length }}
        onSelect={(id) => {
          terminals.updateDock(cwd, (d) => selectDockTerminal(d, id));
          onShowTerminal?.();
        }}
        onSelectDev={noop}
        onAdd={
          onShowTerminal
            ? () => {
                // Where the terminal dock's own New terminal opens: the thread on screen's folder.
                if (dock) terminals.openNext(cwd, activeCwd || cwd);
                onShowTerminal();
              }
            : undefined
        }
        onHide={() => {
          devPane.close();
          terminals.updateDock(cwd, (d) => withDockOpen(d, false));
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r border-border">
          <DevStarter starter={starter} />
          {servers.length > 0 ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-2 p-1.5">
                {serverGroups(servers).map((group) => (
                  <ItemGroup key={group.key} aria-label={group.owner} data-dev-group={group.key} className="gap-0.5">
                    <div className="truncate px-2 pt-1 text-xs font-medium text-muted-foreground">{group.owner}</div>
                    {group.servers.map((server) => (
                      <DevServerRow key={server.key} server={server} picked={server.key === shown?.key} onPick={() => devPane.pick(server.key)} />
                    ))}
                  </ItemGroup>
                ))}
              </div>
            </ScrollArea>
          ) : null}
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {shown ? (
            <DevConsole
              key={shown.key}
              source={{
                environmentId: shown.environmentId,
                ...(shown.runId ? { runId: shown.runId } : {}),
                ...(shown.resource ? { resourceId: shown.resource.id } : {}),
              }}
              active
            />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No dev servers running</EmptyTitle>
                {emptyLine(starter.targets, starter.target)}
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DockFrame>
  );
}

/** Under the empty state's title: what Run would start, or why nothing can. */
function emptyLine(targets: DevTarget[] | null | undefined, target: DevTarget | undefined) {
  if (targets === undefined) return null;
  if (targets === null) return <EmptyDescription>This host can't run dev servers</EmptyDescription>;
  if (!target) return <EmptyDescription>Nothing to serve here</EmptyDescription>;
  return <EmptyDescription className="font-mono text-xs">{commandLine(target)}</EmptyDescription>;
}

/** A target's command as one line: an Xcode target's `xcodebuild  <script>`, else the command itself. */
export function commandLine(target: Pick<DevTarget, "command" | "script">): string {
  return target.command.split("\n").some((line) => line.startsWith("xcodebuild")) ? `xcodebuild  ${target.script}` : target.command;
}

const noop = () => {};
const EMPTY_FILES: never[] = [];

/** The dock of the project on screen: the same derivation as `currentDockCwd()`, as React state. */
function useCurrentDock() {
  const projectCwd = useProject((s) => s.projectCwd);
  const selectedProjectId = useProject((s) => s.selectedProjectId);
  const projects = useProjects();
  const cwd = dockCwdOf({ projectCwd, selectedProjectId }, projects);
  const dock = useTerminals((s) => findProjectTerminal(s.docks, cwd));
  return { cwd, dock };
}
