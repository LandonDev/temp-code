/** Frames a navigation waits for its line to exist (a document still loading) before it lands on the last line there is. */
export const NAVIGATION_RETRY_FRAMES = 120;

type Frames = {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
};

const browserFrames: Frames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Runs `reveal` two frames on (the editor has laid the document out) once
 * the document holds `line`, or after NAVIGATION_RETRY_FRAMES more frames
 * with what it holds: a stale link past the end of a file never keeps a
 * frame loop alive. Returns the cancel.
 */
export function revealWhenLoaded(lines: () => number, line: number, reveal: () => void, frames: Frames = browserFrames): () => void {
  let cancelled = false;
  let left = NAVIGATION_RETRY_FRAMES;
  let id = 0;
  const run = () => {
    if (cancelled) return;
    if (lines() < line && left-- > 0) {
      id = frames.request(run);
      return;
    }
    reveal();
  };
  id = frames.request(() => {
    id = frames.request(run);
  });
  return () => {
    cancelled = true;
    frames.cancel(id);
  };
}
