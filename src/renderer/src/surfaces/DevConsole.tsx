import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { DevPortLog, DevRun, DevRunPush } from "@server/shared/contract-devservers";
import type { ServerPush } from "@server/shared/contract";
import { registry } from "../lib/connection/registry";
import { isLightScheme, SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { fitTerminal } from "../lib/terminalLayout";
import { monoFont, terminalTheme } from "./TerminalView";
import "@xterm/xterm/css/xterm.css";

/** How often an agent's server's log is read again. */
const POLL_MS = 1_000;

const dim = (text: string) => `\x1b[2m${text}\x1b[0m\r\n`;

/** Which server a console reads: a Dev Server run, or a `port` row on a thread's ledger, on the host that serves its log. */
export interface DevConsoleSource {
  environmentId: string;
  runId?: string;
  resourceId?: string;
  /** A ledger row's command, its console's first line (a run's log names its own). */
  command?: string | null;
}

/**
 * A live dev server's console in the Dev servers pane: xterm, read-only, with
 * the server's own colours. A Dev Server run replays its buffered log
 * (`devServer.log`) and follows the `dev-run` pushes by line count; a port a
 * thread opened tails its output file, or shows the shell call's output,
 * through `devServer.portLog` from the offset it last read; both open with
 * the command, dimmed. When the host
 * drops the server its row leaves the pane and this console with it, so it
 * never writes an ending of its own; it just stops reading.
 */
export function DevConsole({ source, active }: { source: DevConsoleSource; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      cursorStyle: "bar",
      fontFamily: monoFont(),
      fontSize: 13,
      lineHeight: 1,
      scrollback: 10_000,
      allowTransparency: true,
      smoothScrollDuration: 0,
      theme: terminalTheme(isLightScheme()),
    });
    term.open(host);
    termRef.current = term;
    let closed = false;

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    host.addEventListener("copy", onCopy);
    // ⌘C with a selection goes to the copy event above.
    term.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && term.hasSelection()));

    const onScheme = () => (term.options.theme = terminalTheme(isLightScheme()));
    window.addEventListener(SCHEME_CHANGE_EVENT, onScheme);

    let raf = 0;
    const fit = () => {
      if (!closed) fitTerminal(term, host, "shell");
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fit();
      });
    });
    observer.observe(host);
    requestAnimationFrame(fit);

    const link = registry.linkOf(source.environmentId);
    const stop: (() => void)[] = [];

    if (source.runId) {
      const runId = source.runId;
      // Lines through `written` are on screen; a push names the count its lines end at.
      let written = -1;
      const queued: DevRunPush[] = [];
      const take = (push: DevRunPush) => {
        const start = (push.end ?? written + push.lines.length) - push.lines.length;
        const fresh = push.lines.slice(Math.max(0, written - start));
        if (fresh.length) term.write(fresh.join("\n") + "\n");
        written = Math.max(written, start + push.lines.length);
      };
      stop.push(
        link.onPush((push: ServerPush) => {
          if (push.push !== "dev-run" || push.run.id !== runId) return;
          if (written < 0) queued.push(push);
          else take(push);
        }),
      );
      void link
        .request<{ run: DevRun; lines: string[]; end?: number }>("devServer.log", { runId })
        .then(({ run, lines, end }) => {
          if (closed) return;
          term.write(dim(`$ ${run.command.split("\n")[0]}`));
          if (lines.length) term.write(lines.join("\n") + "\n");
          written = end ?? lines.length;
          for (const p of queued.splice(0)) take(p);
        })
        .catch((err: unknown) => {
          if (!closed) term.write(dim(err instanceof Error ? err.message : String(err)));
        });
    } else if (source.resourceId) {
      const resourceId = source.resourceId;
      let from: number | undefined;
      let shown: DevPortLog["source"] | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const head = () => {
        if (source.command) term.write(dim(`$ ${source.command.split("\n")[0]}`));
      };
      head();
      const poll = async () => {
        try {
          const log = await link.request<DevPortLog>("devServer.portLog", { resourceId, ...(from === undefined ? {} : { from }) });
          if (closed) return;
          if (shown !== null && log.source !== shown && from !== undefined) {
            // The log moved (the call's output gave way to its file): start over.
            term.reset();
            head();
            from = undefined;
          } else {
            if (log.data) term.write(log.data);
            from = log.next;
          }
          shown = log.source;
          // The server stopped: its row is leaving the pane; nothing more to read.
          if (log.endedAt !== undefined && from !== undefined) return;
        } catch (err) {
          if (closed) return;
          term.write(dim(err instanceof Error ? err.message : String(err)));
          return;
        }
        timer = setTimeout(() => void poll(), POLL_MS);
      };
      void poll();
      stop.push(() => timer && clearTimeout(timer));
    }

    return () => {
      closed = true;
      for (const s of stop) s();
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      fitRef.current = () => {};
      host.removeEventListener("copy", onCopy);
      window.removeEventListener(SCHEME_CHANGE_EVENT, onScheme);
      term.dispose();
      termRef.current = null;
    };
  }, [source.environmentId, source.runId, source.resourceId]);

  useEffect(() => {
    if (active) fitRef.current();
  }, [active]);

  return (
    <div className="monocode-terminal flex h-full w-full min-h-0 min-w-0 flex-col">
      <div ref={hostRef} className="monocode-terminal-host min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  );
}
