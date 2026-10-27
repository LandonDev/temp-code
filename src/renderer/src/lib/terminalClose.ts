import { confirmAction, type ConfirmRequest } from "../chrome/ConfirmDialog";
import type { FilePaneTab } from "./layout";
import { getPtyStatus } from "./pty";
import { terminalTabLabel } from "./terminalTab";

type RunningTerminal = {
  file: FilePaneTab;
  process: string;
};

async function runningTerminals(files: FilePaneTab[]): Promise<RunningTerminal[]> {
  const running: RunningTerminal[] = [];
  for (const file of files) {
    if (!file.terminal) continue;
    try {
      const { foreground } = await getPtyStatus(file.id);
      const process = foreground?.trim();
      if (process) running.push({ file, process });
    } catch {
      // PTY already gone — nothing to confirm.
    }
  }
  return running;
}

/** Confirm closing one terminal when its foreground process is not the shell. */
export function confirmCloseTerminal(file: FilePaneTab): Promise<boolean> {
  return confirmCloseTerminals([file]);
}

/** Confirm closing terminals that still have a foreground process. */
export async function confirmCloseTerminals(files: FilePaneTab[]): Promise<boolean> {
  const running = await runningTerminals(files);
  if (running.length === 0) return true;
  return confirmAction(closeTerminalsRequest(running));
}

/** The confirm for busy terminals: "Close dev?" / "vite is still running.",
 *  or "Close 3 terminals?" / "bun dev and 2 more are still running." */
export function closeTerminalsRequest(running: readonly RunningTerminal[]): ConfirmRequest {
  const [first, ...rest] = running;
  const title = rest.length === 0 ? `Close ${terminalTabLabel(first.file)}?` : `Close ${running.length} terminals?`;
  const busy = rest.length === 0 ? `${first.process} is` : `${first.process} and ${rest.length} more are`;
  return { title, body: `${busy} still running.`, action: "Close", danger: true };
}
