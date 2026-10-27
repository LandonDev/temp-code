import { useState } from "react";
import { useStore } from "zustand";
import { Button } from "../components/ui/button";
import { Item, ItemActions, ItemContent, ItemTitle } from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { openUrl, portOpen } from "../lib/devPorts";
import { stopLiveServer, type LiveServer } from "../lib/devServers";
import { macBridgeStore } from "../lib/macBridge";
import { isWebMode } from "../lib/nativeWeb";
import { HostGlyph } from "./HostGlyph";
import { Square } from "./icons";

/**
 * One live dev server (docs/box.md "Dev servers on the box"), the same row
 * in the Dev servers pane and in a thread's Resources: what it is in plain
 * words, its address on its host, "Open on the Mac :5174" when it opens
 * here, and Stop. `onPick` makes the row pick its console (the pane).
 */
export function DevServerRow({ server, picked = false, onPick }: { server: LiveServer; picked?: boolean; onPick?: () => void }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  const [stopping, setStopping] = useState(false);
  const port = server.port;
  const open = port && !isWebMode() ? portOpen(port.number, port.environmentId, port.forwards, localId) : null;
  // A server on this machine opens from its own address; one elsewhere says where it lives, then where it opens here.
  const local = open?.label === "Open in browser";
  const stop = () => {
    setStopping(true);
    void stopLiveServer(server)
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };
  const link = (text: string, url: string) => (
    <Button
      variant="link"
      size="xs"
      className="h-auto px-0 text-xs font-normal tabular-nums text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        openUrl(url);
      }}
    >
      {text}
    </Button>
  );
  return (
    <Item
      size="xs"
      role="listitem"
      tabIndex={onPick ? 0 : undefined}
      data-dev-server={server.key}
      aria-current={picked || undefined}
      className={`flex-nowrap rounded-md ${picked ? "bg-muted" : onPick ? "hover:bg-foreground/5" : ""}`}
      onClick={onPick}
      onKeyDown={(event) => {
        if (onPick && event.key === "Enter" && event.target === event.currentTarget) onPick();
      }}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="min-w-0 max-w-full">
          <span className="min-w-0 truncate">{server.title}</span>
          <HostGlyph environmentId={port?.environmentId ?? server.environmentId} />
        </ItemTitle>
        {port ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {local && open ? link(`localhost:${port.number}`, open.url) : <span className="shrink-0">localhost:{port.number}</span>}
            {open && !local ? link(`${open.label} :${open.port}`, open.url) : null}
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
