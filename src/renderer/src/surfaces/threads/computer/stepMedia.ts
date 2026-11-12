import { useEffect, useState } from "react";
import type { ComputerHistoryCall, ComputerHistoryStepAnswer } from "@server/shared/contract-computer";

/**
 * What a step kept, as the section shows it: its picture as an object URL
 * and the text the model read. Read over `computer.history.step` when a row
 * needs it and held in a small cache, so stepping back and forth through a
 * few rows asks once. The cache holds 12 steps, revokes the URL of what it
 * drops, and empties when a key's history goes.
 */
export interface StepMedia {
  /** the call's revision this was read at: a later record (its picture landing) reads again */
  rev: number;
  picture?: { url: string; width: number; height: number; at: number };
  text?: string;
}

export const STEP_MEDIA_LIMIT = 12;
/** A picture on its way past this dims the one still shown. */
export const PICTURE_DIM_MS = 150;

/** Whether the host kept anything for the call: a picture, or a read's text. */
export const keepsMedia = (call: Pick<ComputerHistoryCall, "picture" | "text">): boolean => call.text || (call.picture !== undefined && !("none" in call.picture));

function pictureBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export interface StepMediaCacheOptions {
  read: (key: string, n: number) => Promise<ComputerHistoryStepAnswer>;
  limit?: number;
  /** the host listed a picture and answered none: it is no longer kept */
  onPictureGone?: (key: string, n: number) => void;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export class StepMediaCache {
  /** least recently used first */
  private readonly entries = new Map<string, StepMedia>();
  private readonly loading = new Map<string, Promise<StepMedia>>();
  private readonly limit: number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(private readonly opts: StepMediaCacheOptions) {
    this.limit = opts.limit ?? STEP_MEDIA_LIMIT;
    this.createUrl = opts.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = opts.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  private static id(key: string, n: number): string {
    return `${key}\n${n}`;
  }

  get size(): number {
    return this.entries.size;
  }

  /** What is held for the call at this revision, now the most recently used. */
  peek(key: string, call: Pick<ComputerHistoryCall, "n" | "rev">): StepMedia | undefined {
    const id = StepMediaCache.id(key, call.n);
    const held = this.entries.get(id);
    if (!held || held.rev !== call.rev) return undefined;
    this.entries.delete(id);
    this.entries.set(id, held);
    return held;
  }

  /** The call's picture and text, read once however many ask. */
  load(key: string, call: Pick<ComputerHistoryCall, "n" | "rev" | "picture">): Promise<StepMedia> {
    const held = this.peek(key, call);
    if (held) return Promise.resolve(held);
    const id = StepMediaCache.id(key, call.n);
    const flight = `${id}\n${call.rev}`;
    const pending = this.loading.get(flight);
    if (pending) return pending;
    const load = this.opts
      .read(key, call.n)
      .then((answer) => {
        const media: StepMedia = { rev: call.rev };
        if (answer.picture) {
          const { data, mimeType, width, height, at } = answer.picture;
          media.picture = { url: this.createUrl(pictureBlob(data, mimeType)), width, height, at };
        } else if (call.picture && !("none" in call.picture)) this.opts.onPictureGone?.(key, call.n);
        if (answer.text !== undefined) media.text = answer.text;
        this.put(id, media);
        return media;
      })
      .finally(() => this.loading.delete(flight));
    this.loading.set(flight, load);
    return load;
  }

  private put(id: string, media: StepMedia): void {
    this.drop(id);
    this.entries.set(id, media);
    while (this.entries.size > this.limit) this.drop(this.entries.keys().next().value as string);
  }

  private drop(id: string): void {
    const held = this.entries.get(id);
    if (!held) return;
    this.entries.delete(id);
    if (held.picture) this.revokeUrl(held.picture.url);
  }

  /** A key's history went: nothing of it is shown again. */
  dropKey(key: string): void {
    for (const id of [...this.entries.keys()]) if (id.startsWith(`${key}\n`)) this.drop(id);
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }
}

/** A row's kept media as the section asks for it. */
export interface MediaWant {
  id: string;
  key: string;
  call: ComputerHistoryCall;
}

/**
 * The media of the step the section shows now. `landed` is the last step
 * whose media answered while it was still the one wanted: an answer for a
 * step the selection has moved on from is dropped. While the wanted step is
 * on its way `landed` is still the one before it, and `late` turns true once
 * that has taken more than 150 ms, which dims the old picture.
 */
export function useStepMedia(cache: StepMediaCache, want: MediaWant | null): { landed: { id: string; media: StepMedia } | null; pending: boolean; late: boolean } {
  const [landed, setLanded] = useState<{ id: string; media: StepMedia } | null>(null);
  const [late, setLate] = useState(false);
  const id = want?.id ?? null;
  const rev = want?.call.rev ?? 0;
  const needs = want ? keepsMedia(want.call) : false;

  useEffect(() => {
    setLate(false);
    if (!want || !needs) return;
    const held = cache.peek(want.key, want.call);
    if (held) {
      setLanded({ id: want.id, media: held });
      return;
    }
    let alive = true;
    const timer = setTimeout(() => alive && setLate(true), PICTURE_DIM_MS);
    cache
      .load(want.key, want.call)
      .then((media) => {
        if (!alive) return;
        setLanded({ id: want.id, media });
        setLate(false);
      })
      .catch(() => {
        // the read failed: the step shows what its records say, with no picture
        if (alive) setLanded({ id: want.id, media: { rev: want.call.rev } });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // the call object changes with every revision; its id and revision are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, id, rev, needs]);

  if (!want) return { landed: null, pending: false, late: false };
  // a step that kept nothing needs no read
  if (!needs) return { landed: { id: want.id, media: { rev } }, pending: false, late: false };
  const here = landed?.id === want.id && landed.media.rev === rev;
  return { landed, pending: !here, late: !here && late };
}
