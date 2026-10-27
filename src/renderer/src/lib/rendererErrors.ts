import { registry } from "./connection";

/**
 * One line per render error React hands the root (`createRoot`'s
 * `onUncaughtError` and `onCaughtError`), reported through `stall.report`
 * so it lands in stalls.log as `[renderer] uncaught <name>: <message>` (or
 * `caught`, for one a boundary held). The line is one line, cut at 300
 * characters; the stack stays in the window's console.
 */
export function rendererErrorLine(kind: "caught" | "uncaught", error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${kind} ${name}: ${message}`.replace(/\s+/g, " ").slice(0, 300);
}

export function reportRendererError(
  kind: "caught" | "uncaught",
  error: unknown,
  report: (line: string) => void = (line) =>
    void registry
      .primary()
      .request("stall.report", { line })
      .catch(() => undefined),
): void {
  try {
    report(rendererErrorLine(kind, error));
  } catch {
    // No link yet (an error before the first environment): the console has it.
  }
  console.error(error);
}
