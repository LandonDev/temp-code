/**
 * The git-changed signal every git UI reloads on. A tool result in a thread
 * fires it; unscoped, every listener for every checkout on screen reloaded,
 * so eighteen running threads re-diffed a 49k-file repo nobody had touched
 * on each tool call and starved the server's child budget. The emitter now
 * names the checkout it changed, and a listener bound to a checkout ignores
 * other checkouts' events. An unscoped event (a commit from a UI without a
 * cwd, a branch change) still reaches everyone.
 */
const GIT_CHANGED = "monocode-git-changed";

const scopeOf = (cwd: string | null | undefined): string | null =>
  cwd && cwd !== "~" ? cwd : null;

/** Tell git UIs to reload after a local git mutation, in `cwd` when known. */
export function notifyGitChanged(cwd?: string | null): void {
  window.dispatchEvent(
    new CustomEvent<string | null>(GIT_CHANGED, { detail: scopeOf(cwd) }),
  );
}

/** Listen for git changes; with `cwd`, only those in that checkout. */
export function subscribeGitChanged(
  listener: () => void,
  cwd?: string | null,
): () => void {
  const scope = scopeOf(cwd);
  const handler = (e: Event) => {
    const changed = (e as CustomEvent<string | null>).detail ?? null;
    if (!scope || !changed || sameCheckout(changed, scope)) listener();
  };
  window.addEventListener(GIT_CHANGED, handler);
  return () => window.removeEventListener(GIT_CHANGED, handler);
}

/** One checkout, or one path inside the other (a worktree under the repo). */
export function sameCheckout(a: string, b: string): boolean {
  const x = strip(a);
  const y = strip(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

const strip = (path: string): string =>
  path.length > 1 ? path.replace(/\/+$/, "") : path;
