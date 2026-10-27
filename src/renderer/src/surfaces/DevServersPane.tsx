import { useState } from "react";
import { useStore } from "zustand";
import { DockFrame } from "../chrome/DockFrame";
import { HostGlyph } from "../chrome/HostGlyph";
import { ChevronDown, Play, Square, Terminal } from "../chrome/icons";
import { IconButton } from "../chrome/TitleBar";
import { devPane, useDevPane } from "../lib/devPane";
import { openUrl, portOpen } from "../lib/devPorts";
import { shownServer, stopLiveServer, useLiveDevServers, type LiveServer } from "../lib/devServers";
import { macBridgeStore } from "../lib/macBridge";
import { isWebMode } from "../lib/nativeWeb";
import { rightPanel } from "../lib/rightPanel";
import { Spinner } from "./threads/spinners";
import { DevConsole } from "./DevConsole";

/**
 * The Dev servers pane (docs/box.md "Dev servers on the box"): the bottom
 * dock's other occupant, in the terminal's type and density but its own
 * thing. One row per dev server live on a host right now (a running Dev
 * Server run, or a port a thread opened that still listens); a row leaves
 * the moment its host drops it. The picked row's console fills the rest.
 */
export function DevServersPane({
  onSizePaint,
  onSizeCommit,
  onShowTerminal,
}: {
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  /** Absent at /ui, where there is no terminal to switch to. */
  onShowTerminal?: () => void;
}) {
  const size = useDevPane((s) => s.size);
  const picked = useDevPane((s) => s.picked);
  const servers = useLiveDevServers();
  const shown = shownServer(servers, picked);

  return (
    <DockFrame
      data-dev-servers-pane=""
      size={size}
      focused={false}
      label="Resize dev servers"
      onFocus={noop}
      onSizePaint={onSizePaint}
      onSizeCommit={onSizeCommit}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-content/10 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-content/80">Dev servers</h2>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-content/10 px-2">
          <IconButton label="Start a Dev Server" onClick={() => rightPanel.show("dev")}>
            <Play className="size-3.5" strokeWidth={1.75} />
          </IconButton>
          {onShowTerminal ? (
            <IconButton
              label="Terminal"
              onClick={() => {
                devPane.close();
                onShowTerminal();
              }}
            >
              <Terminal className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          ) : null}
          <IconButton label="Hide Dev Servers" onClick={devPane.close}>
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
      {shown ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div
            role="listbox"
            aria-label="Dev servers"
            className="w-72 shrink-0 overflow-y-auto border-r border-content/10 py-1"
          >
            {servers.map((server) => (
              <ServerRow key={server.key} server={server} selected={server.key === shown.key} />
            ))}
          </div>
          <div className="relative min-h-0 min-w-0 flex-1">
            <DevConsole
              key={shown.key}
              source={{
                environmentId: shown.environmentId,
                ...(shown.runId ? { runId: shown.runId } : {}),
                ...(shown.resource ? { resourceId: shown.resource.id } : {}),
              }}
              active
            />
          </div>
        </div>
      ) : (
        <p className="px-3 py-2 text-[12px] text-content/45">No dev servers running</p>
      )}
    </DockFrame>
  );
}

const noop = () => {};

function ServerRow({ server, selected }: { server: LiveServer; selected: boolean }) {
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
  return (
    <div
      data-dev-server={server.key}
      className={`group flex h-7 items-center gap-1 pl-1 pr-1.5 text-[12px] ${selected ? "bg-content/8" : "hover:bg-content/5"}`}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        title={server.thread ?? undefined}
        onClick={() => devPane.pick(server.key)}
        className={`flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left ${selected ? "text-content" : "text-content/60 hover:text-content"}`}
      >
        <span className="min-w-0 truncate">{server.title}</span>
        <HostGlyph environmentId={server.port?.environmentId ?? server.environmentId} />
      </button>
      <div
        className={`flex shrink-0 items-center gap-0.5 ${
          selected || stopping ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        {open ? (
          <button
            type="button"
            title={open.movedFrom ? `${open.url} · ${open.movedFrom} is taken here` : open.url}
            onClick={() => openUrl(open.url)}
            className="pressable h-6 shrink-0 rounded-md px-1.5 text-[11px] tabular-nums text-content/55 hover:bg-content/8 hover:text-content"
          >
            {open.label} :{open.port}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Stop"
          title="Stop"
          disabled={stopping}
          onClick={stop}
          className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
        >
          {stopping ? <Spinner className="size-3" /> : <Square className="size-3" strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}
