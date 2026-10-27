import {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { Button } from "@renderer/components/ui/button";

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
 *
 * A surface that throws (its import failed, or it threw while rendering)
 * stays inside its own boundary (`ChunkBoundary`): the fallback stays, still,
 * with "Couldn't load" and Retry over it, and everything beside it (the
 * rail, the other panes) keeps running. React.lazy remembers a rejection for
 * good, so Retry drops the surface's lazy and the chunk's promise and mounts
 * a fresh one, which calls the loader again.
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
      const makeLazy = () =>
        lazy(() => (module ? settled(pick(module)) : start().then(pick)) as Promise<{ default: ComponentType<AnyProps> }>);
      // One lazy per surface, shared by every mount; a retry replaces it.
      // Capitalized and opted out of the React Compiler: it inlines a
      // lowercase alias into the JSX tag (`jsx("current")`) and memoizes a
      // captured variable as a constant, so a retry would render the old lazy.
      let Current: LazyExoticComponent<ComponentType<AnyProps>> = makeLazy();
      const retry = () => {
        Current = makeLazy();
        if (!module) promise = null;
      };
      function Surface(props: AnyProps) {
        "use no memo";
        // The lazy this mount renders, read again after each retry.
        const [, setAttempt] = useState(0);
        const Rendered = Current;
        return (
          <ChunkBoundary
            name={`${name}.${String(key)}`}
            fallback={fallback}
            onRetry={() => {
              if (Rendered === Current) retry();
              setAttempt((n) => n + 1);
            }}
          >
            <Suspense fallback={fallback}>
              <Current {...props} />
            </Suspense>
          </ChunkBoundary>
        );
      }
      Surface.displayName = `Chunk(${name}.${String(key)})`;
      surfaces.set(key, Surface);
      return Surface as ComponentType<PropsOf<M[typeof key]>>;
    },
  };
  return chunk;
}

interface BoundaryProps {
  /** The chunk and surface, for the element's data attribute. */
  name: string;
  fallback: ReactNode;
  onRetry: () => void;
  children: ReactNode;
}

/**
 * One surface's error boundary: on a throw, the surface's fallback held
 * still (no pulse: nothing is loading) with one line and Retry over it.
 * Retry asks the owner to replace the lazy, then remounts the children.
 */
export class ChunkBoundary extends Component<BoundaryProps, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  private retry = (): void => {
    this.props.onRetry();
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    if (!this.state.failed) return <ChunkAttempt key={this.state.attempt}>{this.props.children}</ChunkAttempt>;
    return (
      <div
        data-chunk-failed={this.props.name}
        className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col [&_[data-surface-skeleton]]:animate-none"
      >
        {this.props.fallback}
        <div role="alert" className="absolute inset-0 flex items-center justify-center gap-3">
          <span className="text-[13px] text-muted-foreground">Couldn't load</span>
          <Button variant="secondary" size="sm" onClick={this.retry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
}

/** A keyed pass-through: a new attempt is a fresh subtree. */
function ChunkAttempt({ children }: { children: ReactNode }) {
  return children;
}

/** `preload()` in an idle slot (requestIdleCallback, else a short timer), never during the open. */
export function preloadWhenIdle(chunk: Chunk<object>, timeout = 2000): void {
  if (chunk.started()) return;
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === "function") idle(() => chunk.preload(), { timeout });
  else setTimeout(() => chunk.preload(), 250);
}
