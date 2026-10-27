import { useSyncExternalStore } from "react";

/**
 * "7 threads resumed after restart": the one line a host's rail section
 * shows once per boot of that host. The server pushes `boot-resume`
 * (count, the boot's time) to every socket when its boot resume finishes
 * and to each later socket after hello, so a window that connects a day
 * later would hear it again; the boot's time, kept per host in
 * localStorage, is what makes it once.
 */
export type BootResumeNotice = { environmentId: string; count: number; at: number };

const SEEN_KEY = (environmentId: string): string => `tc:boot-resume-seen:${environmentId}`;

let notices: readonly BootResumeNotice[] = [];
const listeners = new Set<() => void>();

function set(next: readonly BootResumeNotice[]): void {
  notices = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function seenAt(environmentId: string): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY(environmentId));
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** A host's boot-resume push: shown once per boot, then remembered as seen. */
export function noteBootResume(environmentId: string, count: number, at: number): void {
  if (count <= 0 || seenAt(environmentId) === at) return;
  try {
    localStorage.setItem(SEEN_KEY(environmentId), String(at));
  } catch {
    // Private mode or a full store: the line shows, and may show again.
  }
  set([...notices.filter((n) => n.environmentId !== environmentId), { environmentId, count, at }]);
}

export function dismissBootResume(environmentId: string): void {
  if (!notices.some((n) => n.environmentId === environmentId)) return;
  set(notices.filter((n) => n.environmentId !== environmentId));
}

export function useBootResumeNotice(environmentId: string | undefined): BootResumeNotice | null {
  return useSyncExternalStore(subscribe, () =>
    environmentId ? (notices.find((n) => n.environmentId === environmentId) ?? null) : null,
  );
}

/** Every host's notice not yet shown, for the toast that says it once. */
export function useBootResumeNotices(): readonly BootResumeNotice[] {
  return useSyncExternalStore(subscribe, () => notices);
}

/** The line's words: "1 thread resumed after restart", "7 threads …". */
export function bootResumeLine(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"} resumed after restart`;
}

/** Test seam. */
export function resetBootResume(): void {
  notices = [];
}
