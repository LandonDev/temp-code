/**
 * Where the prompt was when it was sent: the composer field's viewport
 * rect, recorded at submit and cleared a second later. The user bubble
 * reads it once at mount to slide in from that box (a transform-only
 * FLIP); a missing or stale origin means the bubble takes its plain rise.
 */
export type SendOrigin = {
  top: number;
  left: number;
  width: number;
  height: number;
  at: number;
};

const FRESH_MS = 1000;

let origin: SendOrigin | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

export function recordSendOrigin(rect: DOMRect, now = Date.now()): void {
  origin = { top: rect.top, left: rect.left, width: rect.width, height: rect.height, at: now };
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    origin = null;
    clearTimer = null;
  }, FRESH_MS);
}

/** The origin recorded within the last second, else null. */
export function sendOrigin(now = Date.now()): SendOrigin | null {
  return origin && now - origin.at <= FRESH_MS ? origin : null;
}

/** The bubble's start offset from its rest box, or null when it should
 *  take the plain rise: no fresh origin, or a jump taller than `cap`. */
export function sendOffset(
  from: SendOrigin | null,
  rest: { top: number; left: number },
  cap = 600,
): { dx: number; dy: number } | null {
  if (!from) return null;
  const dy = from.top - rest.top;
  if (Math.abs(dy) > cap) return null;
  return { dx: from.left - rest.left, dy };
}

/** Test seam. */
export function resetSendOrigin(): void {
  origin = null;
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
}
