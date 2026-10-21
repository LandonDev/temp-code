import {
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * A loading boundary around one dynamic import: the renderer's index bundle
 * carries only what the rail, the transcript, the composer and the thread
 * header paint at launch, and every other surface lives in a chunk behind
 * one of these (surfaces/chunks.ts lists them).
 *
 * `surface(name, fallback)` is React.lazy plus a Suspense boundary; the
 * fallback is the surface's own skeleton (SurfaceSkeleton), so the chrome
 * around it paints with the click. `preload()` runs the import without
 * rendering: a trigger's hover or focus (`intent`) and an idle slot after
 * the first thread opens (`preloadWhenIdle`) warm the chunk, so a click on
 * a warm machine never shows the fallback at all. Once the module has
 * landed, the lazy initializer resolves synchronously (a settled thenable
 * whose `then` calls back at once), so the first mount after a preload
 * commits in one pass instead of suspending for a microtask.
 */

type AnyProps = Record<string, unknown>;
type ComponentKeys<M> = {
  [K in keyof M]: M[K] extends ComponentType<never> ? K : never;
}[keyof M];
type PropsOf<C> = C extends ComponentType<infer P> ? P : never;

export interface IntentProps {
  onPointerEnter: () => void;
  onFocus: () => void;
}

export interface Chunk<M extends object> {
  readonly name: string;
  /** Starts the import once and resolves with the module. */
  load(): Promise<M>;
  /** The warm-up: `load()` with the promise dropped (an import error logs once). */
  preload(): void;
  /** The module once it has landed, else null. */
  loaded(): M | null;
  /** True once a load started, settled or not. */
  started(): boolean;
  /** Handlers for a trigger: hover or focus warms the chunk. */
  readonly intent: IntentProps;
  /** The component `name` of the module behind React.lazy and a Suspense boundary. */
  surface<K extends ComponentKeys<M>>(name: K, fallback?: ReactNode): ComponentType<PropsOf<M[K]>>;
}

/** A thenable that is already settled and calls `then` back synchronously. */
function settled<T>(value: T): PromiseLike<T> {
  return {
    then(onFulfilled) {
      const next = onFulfilled ? onFulfilled(value) : value;
      return settled(next as never);
    },
  } as PromiseLike<T>;
}

export function defineChunk<M extends object>(name: string, load: () => Promise<M>): Chunk<M> {
  let promise: Promise<M> | null = null;
  let module: M | null = null;
  const surfaces = new Map<PropertyKey, ComponentType<AnyProps>>();
  const start = (): Promise<M> => {
    promise ??= load().then(
      (m) => {
        module = m;
        return m;
      },
      (error: unknown) => {
        // A failed import (a chunk missing from disk, say) may be retried by
        // the next mount; the promise would otherwise stay rejected forever.
        promise = null;
        throw error;
      },
    );
    return promise;
  };
  const preload = (): void => {
    start().catch((error: unknown) => {
      console.warn(`[chunk] ${name} failed to preload`, error);
    });
  };
  const chunk: Chunk<M> = {
    name,
    load: start,
    preload,
    loaded: () => module,
    started: () => promise !== null,
    intent: { onPointerEnter: preload, onFocus: preload },
    surface(key, fallback = null) {
      const cached = surfaces.get(key);
      if (cached) return cached as ComponentType<PropsOf<M[typeof key]>>;
      const pick = (m: M) => ({ default: m[key] as unknown as ComponentType<AnyProps> });
      const Lazy = lazy(() => (module ? settled(pick(module)) : start().then(pick)) as Promise<{ default: ComponentType<AnyProps> }>);
      function Surface(props: AnyProps) {
        return (
          <Suspense fallback={fallback}>
            <Lazy {...props} />
          </Suspense>
        );
      }
      Surface.displayName = `Chunk(${name}.${String(key)})`;
      surfaces.set(key, Surface);
      return Surface as ComponentType<PropsOf<M[typeof key]>>;
    },
  };
  return chunk;
}

/** `preload()` in an idle slot (requestIdleCallback, else a short timer), never during the open. */
export function preloadWhenIdle(chunk: Chunk<object>, timeout = 2000): void {
  if (chunk.started()) return;
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === "function") idle(() => chunk.preload(), { timeout });
  else setTimeout(() => chunk.preload(), 250);
}
