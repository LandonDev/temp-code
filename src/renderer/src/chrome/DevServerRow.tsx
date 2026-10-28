import { useState } from "react";
import { useStore } from "zustand";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { Item, ItemActions, ItemContent, ItemTitle } from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { openUrl, portOpen } from "../lib/devPorts";
import { stopLiveServer, type LiveServer } from "../lib/devServers";
import { macBridgeStore } from "../lib/macBridge";
import { isWebMode } from "../lib/nativeWeb";
import { HostGlyph } from "./HostGlyph";

/**
 * One live dev server (docs/box.md "Dev servers on the box"), a row of the
 * Dev servers pane: what it is in plain words, its address on its host,
 * "Open on the Mac :5174" when it opens here, and Stop. The address is the
 * row's Open control (a local server's own address, else the Mac's link);
 * Stop is its one word button. `onPick` makes the row pick its console (the pane).
 */
export function DevServerRow({ server, picked = false, onPick }: { server: LiveServer; picked?: boolean; onPick?: () => void }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = stopping || server.stopping !== undefined;
  const port = server.port;
  const open = port && !isWebMode() ? portOpen(port.number, port.environmentId, port.forwards, localId) : null;
  // A server on this machine opens from its own address; one elsewhere says where it lives, then where it opens here.
  const local = open?.label === "Open in browser";
  const stop = () => {
    setStopping(true);
    setError(null);
    void stopLiveServer(server)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStopping(false));
  };
  const link = (text: string, url: string, name: string) => (
    <Button
      variant="link"
      size="xs"
      aria-label={name}
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
            {local && open ? (
              <Tip label="Open in browser">{link(`localhost:${port.number}`, open.url, `Open localhost:${port.number}`)}</Tip>
            ) : (
              <span className="shrink-0">localhost:{port.number}</span>
            )}
            {open && !local ? link(`${open.label} :${open.port}`, open.url, `${open.label}, port ${open.port}`) : null}
          </div>
        ) : null}
        {error || server.stopping ? (
          <div className={`truncate text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error ?? server.stopping}</div>
        ) : null}
      </ItemContent>
      <ItemActions>
        {/* The word says what it does: no tooltip. */}
        <Button
          variant="ghost"
          size="xs"
          disabled={pending}
          aria-busy={pending || undefined}
          className="text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            stop();
          }}
        >
          {pending ? <Spinner aria-hidden className="size-3" /> : null}
          Stop
        </Button>
      </ItemActions>
    </Item>
  );
}
