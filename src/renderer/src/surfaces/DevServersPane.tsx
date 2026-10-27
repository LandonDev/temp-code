import { useLayoutEffect, useState } from "react";
import type { DevTarget } from "@server/shared/contract-devservers";
import { useStore } from "zustand";
import { DEV_TAB, DockBar } from "../chrome/DockBar";
import { DockFrame } from "../chrome/DockFrame";
import { HostGlyph } from "../chrome/HostGlyph";
import { Square } from "../chrome/icons";
import { DevStarter, useDevStarter } from "../chrome/rail/DevServerPanel";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "../components/ui/item";
import { ScrollArea } from "../components/ui/scroll-area";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { devPane, useDevPane } from "../lib/devPane";
import { openUrl, portOpen } from "../lib/devPorts";
import { shownServer, stopLiveServer, useDevTab, useDockProject, useLiveDevServers, type LiveServer } from "../lib/devServers";
import { macBridgeStore } from "../lib/macBridge";
import { isWebMode } from "../lib/nativeWeb";
import { findProjectTerminal, selectDockTerminal, withDockOpen, withDockSize } from "../lib/projectTerminal";
import { useProjects } from "../lib/tcserver/workspaces";
import { dockCwdOf, useProject } from "../stores/project";
import { terminals, useTerminals } from "../stores/terminals";
import { DevConsole } from "./DevConsole";

/**
 * The Dev servers pane (docs/box.md "Dev servers on the box"): the bottom
 * dock's other occupant, under the same bar as the terminals (its Dev
 * servers tab is the one picked) and at the dock's height. The starter
 * runs a target; below it, one row per dev server live on a host right now
 * (a running Dev Server run, or a port a thread opened that still listens);
 * a row leaves the moment its host drops it. The picked row's console fills
 * the rest.
 */
export function DevServersPane({
  onSizePaint,
  onSizeCommit,
  onShowTerminal,
}: {
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  onShowTerminal: () => void;
}) {
  const size = useDevPane((s) => s.size);
  const picked = useDevPane((s) => s.picked);
  const servers = useLiveDevServers();
  const shown = shownServer(servers, picked);
  const { cwd, dock } = useCurrentDock();
  const dev = useDevTab(cwd);
  const project = useDockProject(cwd);
  const starter = useDevStarter(project?.id ?? null);

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
        terminals={dock?.pane.files ?? EMPTY_FILES}
        active={DEV_TAB}
        dev={dev ?? { count: servers.length }}
        onSelect={(id) => {
          terminals.updateDock(cwd, (d) => selectDockTerminal(d, id));
          onShowTerminal();
        }}
        onSelectDev={noop}
        onAdd={() => {
          if (dock) terminals.openNext(cwd);
          onShowTerminal();
        }}
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
              <ItemGroup aria-label="Dev servers" className="gap-0.5 p-1.5">
                {servers.map((server) => (
                  <ServerRow key={server.key} server={server} picked={server.key === shown?.key} />
                ))}
              </ItemGroup>
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

function ServerRow({ server, picked }: { server: LiveServer; picked: boolean }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  const [stopping, setStopping] = useState(false);
  const open =
    server.port && !isWebMode() ? portOpen(server.port.number, server.port.environmentId, server.port.forwards, localId) : null;
  const stop = () => {
    setStopping(true);
    void stopLiveServer(server)
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };
  const title = (
    <ItemTitle className="min-w-0 max-w-full">
      <span className="min-w-0 truncate">{server.title}</span>
      <HostGlyph environmentId={server.port?.environmentId ?? server.environmentId} />
    </ItemTitle>
  );
  return (
    <Item
      size="xs"
      role="listitem"
      tabIndex={0}
      data-dev-server={server.key}
      aria-current={picked || undefined}
      className={`flex-nowrap rounded-md ${picked ? "bg-muted" : "hover:bg-foreground/5"}`}
      onClick={() => devPane.pick(server.key)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) devPane.pick(server.key);
      }}
    >
      <ItemContent className="min-w-0 gap-0.5">
        {server.thread ? (
          <Tooltip>
            <TooltipTrigger render={title} />
            <TooltipContent>{server.thread}</TooltipContent>
          </Tooltip>
        ) : (
          title
        )}
        {open ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs font-normal tabular-nums text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                openUrl(open.url);
              }}
            >
              {open.label} :{open.port}
            </Button>
            {open.movedFrom ? <span className="truncate">{open.movedFrom} is taken here</span> : null}
          </div>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Stop"
                disabled={stopping}
                className="text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  stop();
                }}
              />
            }
          >
            {stopping ? <Spinner className="size-3" /> : <Square className="size-3" strokeWidth={2} />}
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      </ItemActions>
    </Item>
  );
}
