import { loadToast } from "../components/ui/toaster";

/**
 * A thread action the host refused, or that never reached it, said once in a
 * toast: "Couldn't delete it" over "<thread>: <why>". Nothing a person picks
 * on a thread (Stop, Archive, Delete, Remove from queue, the batch's
 * switches) fails in silence. Callers in the first paint reach it through
 * lib/threadActionToast.ts.
 */

/** The host's words for why, as a person reads them. */
export function failureReason(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim().replace(/\.$/, "");
  if (!raw) return "";
  if (/^unknown (session|thread)\b/i.test(raw)) return "It is no longer on its host";
  if (/socket closed|not connected|link .*down|linkDown/i.test(raw)) return "Its host is not connected";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** The toast's two lines: what failed, then the thread and the reason. */
export function failureToast(verb: string, title: string, err: unknown): { title: string; description: string } {
  const reason = failureReason(err);
  return { title: `Couldn't ${verb}`, description: reason ? `${title}: ${reason}` : title };
}

export function toastActionFailed(verb: string, title: string, err: unknown): void {
  const { title: heading, description } = failureToast(verb, title, err);
  void loadToast().then((toast) => toast.error(heading, { description }));
}
