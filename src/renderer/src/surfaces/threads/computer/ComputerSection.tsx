import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerHistoryCall } from "@server/shared/contract-computer";
import { loadToast } from "../../../components/ui/toaster";
import { openLightbox } from "../../../chrome/lightboxStore";
import { useDocumentVisible, usePaneVisible } from "../../../hooks/paneVisibility";
import { computerLabel } from "../../../lib/activity";
import {
  flatRows,
  historyKeyOf,
  loadOlderHistory,
  markPictureGone,
  nowState,
  readHistoryStep,
  retryHistory,
  rowsOf,
  type HistorySession,
  type StepList as Steps,
  type StepRow,
} from "../../../lib/computerHistory";
import { useComputerSection, type ComputerSectionData } from "../../../lib/computerSection";
import { stopComputer, type ComputerEntry } from "../../../lib/computerSessions";
import { LOCAL_ENVIRONMENT_ID } from "../../../lib/connection/registry";
import { clockTime } from "../../../lib/duration";
import { useSessionMetas } from "../../../lib/tcserver/store";
import { ComputerView, type LiveSession } from "./ComputerView";
import { rowWords, type RunningLine } from "./StepList";
import { StepMediaCache, keepsMedia, useStepMedia, type MediaWant } from "./stepMedia";
import { ENDED_WORDS, NO_PICTURE_WORDS, RETRY_ENDS, ViewportLine, liveFace, streamSize, useLiveStream, type LiveStream, type ViewportProps } from "./Viewport";

/**
 * The Computer section's container (docs/LAYOUT.md "The right side"): it
 * joins the thread's live sessions, the journal this Mac keeps for its tree
 * and the live stream, and hands ComputerView what to draw.
 *
 * With nothing chosen by hand the section follows: the viewport is the live
 * stream while a session is live (else the newest call's picture) and the
 * open row is the newest step with an outcome. A click or a key on a row
 * pins it: the viewport is that call's own picture, the stream stops (the
 * Mac stops capturing for it), and Go live, the running line or Home follow
 * again. The stream runs only while the section is shown, the window
 * visible and the section following.
 */

const sessionId = (entry: ComputerEntry): string => `${entry.host}:${entry.row.threadId}`;
const windowIn = (call: Pick<ComputerHistoryCall, "app" | "window">): string => (call.window ? `${call.window} in ${call.app}` : call.app || "the Mac");
const wantOf = (row: StepRow | null): MediaWant | null => (row ? { id: `${row.key}:${row.call.n}`, key: row.key, call: row.call } : null);

/** The running calls as lines: each live session's card, hold or call, worded from the journal's start where it has one. */
export function runningLines(entries: readonly ComputerEntry[], list: Steps): RunningLine[] {
  const starts = new Map(list.running.map((r) => [r.key, r]));
  const several = entries.length > 1;
  const lines: RunningLine[] = [];
  for (const entry of entries) {
    const key = historyKeyOf(entry);
    const start = key ? starts.get(key) : undefined;
    if (key) starts.delete(key);
    const state = nowState(entry.row);
    if (!state && !start) continue;
    const id = `running:${sessionId(entry)}`;
    // with one session its row above says the app; with several each line says its own
    const words = start ? rowWords({ ...start, namesApp: several }, true) : null;
    if (state === "waiting") lines.push({ id, state, verb: "", object: entry.row.asking?.line ?? "" });
    else if (state === "queued") lines.push({ id, state, verb: "", object: entry.row.running?.words ?? "", ...(words ? { waits: [words.verb, words.object].filter(Boolean).join(" ") } : {}) });
    else if (words) lines.push({ id, state: "working", ...words, ...(start?.call.plan?.length ? { plan: start.call.plan } : {}) });
    else lines.push({ id, state: "working", verb: "", object: entry.row.running?.words ?? "" });
  }
  // a call the journal says runs whose live row has not come yet
  for (const start of starts.values()) lines.push({ id: `running:${start.key}`, state: "working", ...rowWords({ ...start, namesApp: true }, true), ...(start.call.plan?.length ? { plan: start.call.plan } : {}) });
  return lines;
}

/** What the viewport shows and says, from what the section knows; null draws nothing above the list. */
export function viewportOf(v: {
  /** the session the viewport follows, with its stream; null when none is live */
  live: { entry: ComputerEntry; stream: LiveStream } | null;
  /** a row chosen by hand */
  pinned: StepRow | null;
  /** the step whose kept media stands in for the stream: the pinned row, else the newest one where nothing is live or the stream ended */
  shown: StepRow | null;
  media: ReturnType<typeof useStepMedia>;
  keptHeight: number | null;
  onOpen: (label: string, url: string, from: DOMRect) => void;
}): ViewportProps | null {
  const { live, pinned, shown, media, keptHeight } = v;
  const state = live?.stream.state;
  const over = state?.status === "ended" || state?.status === "failed";
  // Following a live window: the stream, a skeleton in its shape until the first frame.
  if (live && !pinned && !over) return { face: liveFace(live.stream), label: `Live view of ${computerLabel(live.entry)}`, size: streamSize(live.stream.state) };
  // The stream ended: today's line, under the newest step's kept picture when there is one.
  const ended =
    live && !pinned && state && over ? (
      <ViewportLine
        words={state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
        onRetry={state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason)) ? live.stream.retry : undefined}
      />
    ) : null;
  if (!shown) return ended ? { face: null, label: "", line: ended } : null;
  const { call } = shown;
  const label = `${windowIn(call)} at ${clockTime(call.endedAt ?? call.at)}`;
  const size = call.picture && !("none" in call.picture) ? { width: call.picture.width, height: call.picture.height } : null;
  const here = media.landed?.id === `${shown.key}:${call.n}` ? media.landed.media : null;
  const base = { label, size, height: pinned ? keptHeight : null };
  if (!here) {
    // on its way: the picture before it stays, dimmed once that has taken a moment; a first picture is a skeleton
    const before = media.landed?.media.picture;
    if (before) return { ...base, face: { kind: "picture", src: before.url, dim: media.late }, line: ended };
    return keepsMedia(call) ? { ...base, face: { kind: "skeleton" }, line: ended } : ended ? { face: null, label, line: ended } : null;
  }
  if (here.picture) {
    const url = here.picture.url;
    // one picture per call: a batch's earlier step shows the window after all of them, and says so
    const after = pinned && call.steps.length > 1 && shown.index < call.steps.length - 1 ? <ViewportLine words={`After all ${call.steps.length} steps`} /> : null;
    return { ...base, size: { width: here.picture.width, height: here.picture.height }, face: { kind: "picture", src: url, onOpen: (from) => v.onOpen(label, url, from) }, line: ended ?? after };
  }
  // no picture: what the model read stands in its place, and why there is none where that is worth a line
  const none = call.picture && "none" in call.picture ? NO_PICTURE_WORDS[call.picture.none] : undefined;
  const why = ended ?? (none ? <ViewportLine words={none} /> : null);
  if (here.text) return { ...base, size: null, face: { kind: "text", text: here.text }, line: why };
  return why ? { face: null, label, line: why } : null;
}

export function ComputerSection({ threadId }: { threadId: string }) {
  const data = useComputerSection(threadId);
  return <ComputerSectionBody threadId={threadId} data={data} />;
}

/** The section over what its hook read (ComputerSection; tests give it the data). */
export function ComputerSectionBody({ threadId, data }: { threadId: string; data: ComputerSectionData }) {
  const metas = useSessionMetas();
  const paneShown = usePaneVisible();
  const docShown = useDocumentVisible();
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);

  // ── the list ──
  const sessions = useMemo<HistorySession[]>(
    () =>
      data.keys.map(({ key, threadId: id }) => ({
        key,
        threadId: id,
        ...(id !== threadId ? { title: metas.find((m) => m.id === id)?.title || "Subagent" } : {}),
        calls: data.histories[key]?.calls ?? [],
      })),
    [data.histories, data.keys, metas, threadId],
  );
  const list = useMemo(() => rowsOf(sessions), [sessions]);
  const rows = useMemo(() => flatRows(list), [list]);

  // ── following and pinning ──
  const [selected, setSelected] = useState<string | null>(null);
  const [keptHeight, setKeptHeight] = useState<number | null>(null);
  const pinnedRow = selected ? (rows.find((r) => r.id === selected) ?? null) : null;
  const openRow = pinnedRow ?? rows[0] ?? null;
  const lead = data.entries[0] ?? null;
  const stream = useLiveStream(lead, !pinnedRow && paneShown && docShown, box, root);
  const over = stream.state.status === "ended" || stream.state.status === "failed";

  // ── kept pictures and read texts ──
  const [cache] = useState(() => new StepMediaCache({ read: readHistoryStep, onPictureGone: markPictureGone }));
  useEffect(() => () => cache.clear(), [cache]);
  // a history that was removed, or removed and begun again, shows nothing of what it was
  const births = useRef(new Map<string, number>());
  useEffect(() => {
    for (const { key } of data.keys) {
      const born = data.histories[key]?.born ?? 0;
      const was = births.current.get(key);
      if (was !== undefined && was !== born) cache.dropKey(key);
      births.current.set(key, born);
    }
  }, [cache, data.histories, data.keys]);

  // With Screen Recording off the newest read's text stands in for the window.
  const noRecording = stream.state.status === "ended" && stream.state.reason === "permission";
  const shownRow = pinnedRow ?? (!lead || over ? ((noRecording ? rows.find((r) => r.call.text) : undefined) ?? openRow) : null);
  const media = useStepMedia(cache, wantOf(shownRow));

  // The open row's read: closed whenever the open row changes.
  const [readFor, setReadFor] = useState<string | null>(null);
  if (readFor !== null && readFor !== (openRow?.id ?? null)) setReadFor(null);
  const readRow = openRow !== null && readFor === openRow.id ? openRow : null;
  const readOpen = readRow !== null;
  const readMedia = useStepMedia(cache, wantOf(readRow));
  const readText = readRow && readMedia.landed?.id === `${readRow.key}:${readRow.call.n}` && !readMedia.pending ? (readMedia.landed.media.text ?? "") : null;

  const onSelect = useCallback(
    (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return;
      // the box keeps the height it has now for as long as a row is pinned
      if (!pinnedRow) setKeptHeight(box.current?.getBoundingClientRect().height || null);
      setSelected(id);
      // the rows either side are a key away
      for (const near of [rows[at - 1], rows[at + 1]]) if (near && near.call !== rows[at].call && keepsMedia(near.call)) void cache.load(near.key, near.call).catch(() => undefined);
    },
    [cache, pinnedRow, rows],
  );
  const onFollow = useCallback(() => {
    setSelected(null);
    setKeptHeight(null);
  }, []);
  const onToggleRead = useCallback(() => setReadFor((was) => (openRow && was !== openRow.id ? openRow.id : null)), [openRow]);

  // ── the sessions and their Stop ──
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const onStop = useCallback(
    (id: string) => {
      const entry = data.entries.find((e) => sessionId(e) === id);
      if (!entry || stopping.has(id)) return;
      setStopping((was) => new Set(was).add(id));
      stopComputer(entry)
        .catch(() => loadToast().then((toast) => toast.error("Couldn't stop it", { description: computerLabel(entry) })))
        .finally(() =>
          setStopping((was) => {
            const next = new Set(was);
            next.delete(id);
            return next;
          }),
        );
    },
    [data.entries, stopping],
  );
  const live = useMemo<LiveSession[]>(() => data.entries.map((e) => ({ id: sessionId(e), label: computerLabel(e), stopping: stopping.has(sessionId(e)) })), [data.entries, stopping]);
  const running = useMemo(() => runningLines(data.entries, list), [data.entries, list]);

  // ── the journal's own state ──
  const keysId = data.keys.map((k) => k.key).join("\n");
  const keys = useMemo(() => (keysId ? keysId.split("\n") : []), [keysId]);
  const histories = keys.map((key) => data.histories[key]);
  const status = histories.some((h) => h?.status === "failed") ? "failed" : histories.some((h) => !h || h.status === "loading") && rows.length === 0 ? "loading" : "ready";
  const [loadingMore, setLoadingMore] = useState(false);
  const onOlder = useCallback(() => {
    setLoadingMore(true);
    void Promise.all(keys.filter((key) => data.histories[key]?.more).map((key) => loadOlderHistory(key).catch(() => undefined))).finally(() => setLoadingMore(false));
  }, [data.histories, keys]);
  const onRetry = useCallback(() => retryHistory(keys), [keys]);

  const viewport = viewportOf({
    live: lead ? { entry: lead, stream } : null,
    pinned: pinnedRow,
    shown: shownRow,
    media,
    keptHeight,
    // a kept picture opens the lightbox from the box; the live box does not
    onOpen: (label, url, from) => openLightbox([{ environmentId: LOCAL_ENVIRONMENT_ID, name: label, src: url }], 0, from),
  });

  return (
    <ComputerView
      ref={root}
      boxRef={box}
      sessions={live}
      pinned={pinnedRow !== null}
      viewport={viewport}
      running={running}
      groups={list.groups}
      openId={openRow?.id ?? null}
      read={{ open: readOpen, text: readText }}
      status={status}
      more={histories.some((h) => h?.more)}
      loadingMore={loadingMore}
      onSelect={onSelect}
      onFollow={onFollow}
      onStop={onStop}
      onToggleRead={onToggleRead}
      onRetry={onRetry}
      onOlder={onOlder}
    />
  );
}
