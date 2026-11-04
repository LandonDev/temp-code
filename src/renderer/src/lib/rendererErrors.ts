import { registry } from "./connection";

/**
 * One line per render error React hands the root (`createRoot`'s
 * `onUncaughtError` and `onCaughtError`), reported through `stall.report`
 * so it lands in stalls.log as `[renderer] uncaught <name>: <message>` (or
 * `caught`, for one a boundary held). The line is one line, cut at 300
 * characters; the stack stays in the window's console.
 *
 * A boundary that knows where it sits (a board row's, master/RowBoundary.tsx)
 * tags the error with its place (`tagRendererError`), and the line ends
 * `thread=<id> row=<id>`. React logs a caught error before the boundary's
 * componentDidCatch runs, both in one commit, so the caught line waits one
 * microtask for the tag; an uncaught one goes at once.
 */

export type ErrorPlace = Readonly<Record<string, string>>;

const places = new WeakMap<object, ErrorPlace>();

/** Where a boundary caught the error: `{ thread, row }`, kept for the line. */
export function tagRendererError(error: unknown, place: ErrorPlace): void {
  if (typeof error === "object" && error !== null) places.set(error, place);
}

export function rendererErrorLine(kind: "caught" | "uncaught", error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const place = typeof error === "object" && error !== null ? places.get(error) : undefined;
  const where = place ? ` ${Object.entries(place).map(([k, v]) => `${k}=${v}`).join(" ")}` : "";
  return `${kind} ${name}: ${message}`.replace(/\s+/g, " ").slice(0, 300 - where.length) + where;
}

const toPrimary = (line: string): void =>
  void registry
    .primary()
    .request("stall.report", { line })
    .catch(() => undefined);

export function reportRendererError(kind: "caught" | "uncaught", error: unknown, report: (line: string) => void = toPrimary): void {
  const send = (): void => {
    try {
      report(rendererErrorLine(kind, error));
    } catch {
      // No link yet (an error before the first environment): the console has it.
    }
  };
  if (kind === "caught") queueMicrotask(send);
  else send();
  console.error(error);
}
