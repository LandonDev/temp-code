import { useEffect, useState } from "react";
import { readFile } from "../lib/tcserver/commands";
import { usePaneVisible } from "./paneVisibility";

/**
 * The plan or report file a thread writes, polled through `file.read`.
 * Polling is the only route: `.temp-code` sits in the server's watcher
 * ignore list, so no file event ever fires for it. Null until the file
 * exists; the last good text stays while a poll fails.
 */
export function usePlanFile(
  path: string | null | undefined,
  running: boolean,
  cadence: { running: number; idle: number } = { running: 1500, idle: 8000 },
): string | null {
  const [doc, setDoc] = useState<string | null>(null);
  const shown = usePaneVisible();
  useEffect(() => {
    setDoc(null);
  }, [path]);
  useEffect(() => {
    if (!path || !shown) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      const content = await readFile(path);
      if (alive && content !== null) setDoc((prev) => (prev === content ? prev : content));
    };
    void poll();
    const t = setInterval(() => void poll(), running ? cadence.running : cadence.idle);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, shown, running, cadence.running, cadence.idle]);
  return doc;
}
