import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useSessionTitles } from "../../../lib/tcserver/store";
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
 * again. Opening a row's read text pins it too, so the text stays while
 * more steps land. The stream runs only while the section is shown, the
 * window visible and the section following.
 *
 * A picture that is not the window now, nor the open row's own, says when
 * it was taken under the box: a pinned step's while a session is live, and
 * an older step's where the newest kept nothing.
 */

const sessionId = (entry: ComputerEntry): string => `${entry.host}:${entry.row.threadId}`;

/** How long the followed session may sit idle, while another is at work, before the viewport moves to that one. */
export const FOLLOW_HOLD_MS = 5_000;

const actedAt = (e: ComputerEntry): number => Math.max(e.row.lastCallAt, e.row.running?.startedAt ?? 0);
/** The session at work now, else the one that acted last. */
const busiest = (entries: readonly ComputerEntry[]): ComputerEntry | null =>
  entries.reduce<ComputerEntry | null>((best, e) => (!best || Number(!!e.row.running) - Number(!!best.row.running) > 0 || (!!e.row.running === !!best.row.running && actedAt(e) > actedAt(best)) ? e : best), null);

/**
 * The session the viewport follows. With one live session it is that one.
 * With several it stays with the one it has while that one is at work, and
 * for five seconds after its last call: the sessions of a thread and its
 * subagent take turns on the Mac, and a box that changed windows after
 * every call could not be watched, nor a Stop pressed. It moves when the
 * one it has is gone, or has sat idle that long while another is at work
 * or has acted since: then the live look goes to where something happens.
 */
export function followedSession(entries: readonly ComputerEntry[], held: string | null, now: number): ComputerEntry | null {
  const has = held ? entries.find((e) => sessionId(e) === held) : undefined;
  if (!has) return busiest(entries);
  if (has.row.running) return has;
  const others = entries.filter((e) => e !== has && (e.row.running || actedAt(e) > has.row.lastCallAt));
  return others.length && now - has.row.lastCallAt > FOLLOW_HOLD_MS ? busiest(others) : has;
}
const windowIn = (call: Pick<ComputerHistoryCall, "app" | "window">): string => (call.window ? `${call.window} in ${call.app}` : call.app || "the Mac");
/** When a call's kept picture was taken (after its answer), else when the call ended. */
const shownAt = (call: ComputerHistoryCall): number => (call.picture && !("none" in call.picture) ? call.picture.at : (call.endedAt ?? call.at));
/** What a kept face is, as its accessible name: "Untitled in TextEdit at 2:04 PM". */
const keptLabel = (call: ComputerHistoryCall): string => `${windowIn(call)} at ${clockTime(shownAt(call))}`;
/**
 * A step's media as the section asks for it. Its id carries the history's
 * birth: a history removed and begun again counts its calls from 1 again,
 * and call 1 of the new one is another call, whose media is read anew.
 */
const wantOf = (row: StepRow | null, born: (key: string) => number): MediaWant | null =>
  row ? { id: `${row.key}:${born(row.key)}:${row.call.n}`, key: row.key, call: row.call } : null;

/** The running calls as lines: each live session's card, hold or call, worded from the journal's start where it has one. */
export function runningLines(entries: readonly ComputerEntry[], list: Steps): RunningLine[] {
  const starts = new Map(list.running.map((r) => [r.key, r]));
  const several = entries.length > 1;
  // each session's newest finished call: the rows stand newest first
  const newest = new Map<string, ComputerHistoryCall>();
  for (const group of list.groups) for (const row of group.rows) if (!newest.has(row.key)) newest.set(row.key, row.call);
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
    else if (state === "queued") {
      // a held step has not begun: what waits reads as what is asked ("Press ⌘S"), never as under way
      // (a batch that waits is its planned steps, which are worded that way already)
      const waits = start ? rowWords({ ...start, namesApp: several }, true, true) : null;
      const under = start?.call.plan?.length ? { plan: start.call.plan } : waits ? { waits: [waits.verb, waits.object].filter(Boolean).join(" ") } : {};
      lines.push({ id, state, verb: "", object: entry.row.running?.words ?? "", ...under });
    } else if (words) lines.push({ id, state: "working", ...words, ...(start?.call.plan?.length ? { plan: start.call.plan } : {}) });
    else {
      // The journal's end is told at once and the live row a moment later: a call the journal already ended (it
      // began before the row's call was marked running, and ended after) is not drawn as running again from the
      // row's own words.
      const last = key ? newest.get(key) : undefined;
      const running = entry.row.running;
      if (running && last?.endedAt !== undefined && last.at <= running.startedAt && last.endedAt >= running.startedAt) continue;
      lines.push({ id, state: "working", verb: "", object: running?.words ?? "" });
    }
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
  /** the id that step's media was asked under (`wantOf`) */
  shownId?: string;
  media: ReturnType<typeof useStepMedia>;
  keptHeight: number | null;
  /** what is shown is neither the window now nor the open row's own picture: the line under it says when it was */
  asOf?: boolean;
  /** the stand-in is of another window than the open row's step: the line names it */
  another?: boolean;
  onOpen: (label: string, url: string, from: DOMRect) => void;
}): ViewportProps | null {
  const { live, pinned, shown, media, keptHeight } = v;
  const state = live?.stream.state;
  const over = state?.status === "ended" || state?.status === "failed";
  // Following a live window: the stream, a skeleton in its shape until the first frame.
  if (live && !pinned && !over) return { face: liveFace(live.stream), label: `Live view of ${computerLabel(live.entry)}`, size: streamSize(live.stream.state) };
  // The stream ended: today's line, under the newest step's kept picture when there is one.
  const endedWords = live && !pinned && state && over ? (state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error) : null;
  const endedRetry = live && state && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? live.stream.retry : undefined;
  /** the end's line, with what else there is to say of the picture under it: an older step's stand-in still says whose window and when */
  // (with Screen Recording off the read text is the look there is: its line says what to turn on, and no more
  // unless the text is another window's)
  const endedLine = (also?: string | null): ReactNode => (endedWords ? <ViewportLine words={also ? `${endedWords}. ${also}` : endedWords} onRetry={endedRetry} /> : null);
  const ended = endedLine();
  if (!shown) return ended ? { face: null, label: "", line: ended } : null;
  const { call } = shown;
  const kept = call.picture && !("none" in call.picture) ? call.picture : null;
  // the picture's own time: it is taken after the call's answer
  const at = shownAt(call);
  const label = keptLabel(call);
  const size = kept ? { width: kept.width, height: kept.height } : null;
  const here = media.landed?.id === (v.shownId ?? `${shown.key}:${call.n}`) ? media.landed.media : null;
  const base = { label, size, height: pinned ? keptHeight : null };
  // a pinned row's own facts carry its time; an older step standing in for the newest says when it was, and whose
  // window it is where that is not the newest step's
  const asItWords = v.asOf ? (pinned ? "As it was after this step" : v.another ? `${windowIn(call)}, as it was at ${clockTime(at)}` : `As it was at ${clockTime(at)}`) : null;
  const asIt = asItWords ? <ViewportLine words={asItWords} /> : null;
  // Under a preview that ended, a kept picture is a still under a live session's row: it always says when it was.
  // With Screen Recording off the read text is the look there is, and says its time only when it is not the
  // open step's own.
  const noRecording = state?.status === "ended" && state.reason === "permission";
  const stoodIn = endedWords && !noRecording ? (asItWords ?? `As it was at ${clockTime(at)}`) : asItWords;
  // Nothing to put in a box. A pinned step keeps the box's place, so stepping through rows moves nothing; else the line alone.
  const nothing = (line: ReactNode): ViewportProps | null =>
    pinned && keptHeight ? { ...base, size: null, face: { kind: "none" }, line: line ?? <ViewportLine words="No picture was kept" /> } : line ? { face: null, label, line } : null;
  if (!here) {
    // The read failed: that is not "nothing was kept". The line says so, with Retry, in the box's place.
    // (an ended preview keeps its words beside it; Retry is this read's, the nearer thing to mend)
    if (media.failed) {
      const failed = kept ? "Couldn't read the picture" : "Couldn't read the text";
      return nothing(<ViewportLine words={endedWords ? `${endedWords}. ${failed}` : failed} onRetry={media.retry} />);
    }
    // on its way: the picture before it stays, under its own name, dimmed once that has taken a moment; a first
    // picture is a skeleton
    const before = media.landed?.media.picture;
    if (before && media.landed) {
      return { ...base, label: keptLabel(media.landed.call), face: { kind: "picture", src: before.url, dim: media.late }, line: ended };
    }
    return keepsMedia(call) ? { ...base, face: { kind: "skeleton" }, line: ended } : nothing(ended);
  }
  if (here.picture) {
    const url = here.picture.url;
    // one picture per call: a batch's earlier step shows the window after every step that ran, and says so
    const after =
      pinned && call.steps.length > 1 && shown.index < call.steps.length - 1 ? (
        <ViewportLine words={call.steps.every((step) => step.state === "ok") ? `After all ${call.steps.length} steps` : "After the steps that ran"} />
      ) : null;
    return { ...base, size: { width: here.picture.width, height: here.picture.height }, face: { kind: "picture", src: url, onOpen: (from) => v.onOpen(label, url, from) }, line: endedLine(stoodIn) ?? after ?? asIt };
  }
  // no picture: what the model read stands in its place, and why there is none where that is worth a line
  const none = call.picture && "none" in call.picture ? NO_PICTURE_WORDS[call.picture.none] : undefined;
  const why = endedLine(here.text ? stoodIn : null) ?? (none ? <ViewportLine words={none} /> : null);
  if (here.text) return { ...base, size: null, face: { kind: "text", text: here.text }, line: why ?? asIt };
  return nothing(why);
}

export function ComputerSection({ threadId }: { threadId: string }) {
  const data = useComputerSection(threadId);
  return <ComputerSectionBody threadId={threadId} data={data} />;
}

/** The section over what its hook read (ComputerSection; tests give it the data). */
export function ComputerSectionBody({ threadId, data }: { threadId: string; data: ComputerSectionData }) {
  const paneShown = usePaneVisible();
  const docShown = useDocumentVisible();
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);

  // ── the list ──
  // The subagents' titles as one string: another thread's push renders nothing here, and one that changes no title
  // leaves the rows as they are.
  const threadIds = useMemo(() => data.keys.map((k) => k.threadId), [data.keys]);
  const titles = useSessionTitles(threadIds);
  const sessions = useMemo<HistorySession[]>(() => {
    const names = titles.split("\u0000");
    return data.keys.map(({ key, threadId: id }, i) => ({
      key,
      threadId: id,
      ...(id !== threadId ? { title: names[i] || "Subagent" } : {}),
      calls: data.histories[key]?.calls ?? [],
    }));
  }, [data.histories, data.keys, titles, threadId]);
  const list = useMemo(() => rowsOf(sessions), [sessions]);
  const rows = useMemo(() => flatRows(list), [list]);

  // ── following and pinning ──
  const [selected, setSelected] = useState<string | null>(null);
  const [keptHeight, setKeptHeight] = useState<number | null>(null);
  const pinnedRow = selected ? (rows.find((r) => r.id === selected) ?? null) : null;
  // A pinned row that is gone (its history removed, or begun again) is no pin: a later call with its number is another call.
  if (selected !== null && pinnedRow === null) {
    setSelected(null);
    setKeptHeight(null);
  }
  // Following, the open row is the newest step with an outcome: after a batch that failed part way that is the
  // step that failed, not the last of the steps that never ran.
  const followRow = rows.find((r) => r.step.state !== "not-run") ?? rows[0] ?? null;
  const openRow = pinnedRow ?? followRow;
  // The followed session holds through the other sessions' calls (followedSession). The one held is kept across
  // renders; whether to move on is judged after each change of the rows, and again when the hold runs out.
  const [heldLead, setHeldLead] = useState<string | null>(null);
  const [holdTick, setHoldTick] = useState(0);
  const lead = (heldLead ? data.entries.find((e) => sessionId(e) === heldLead) : undefined) ?? busiest(data.entries);
  const leadId = lead ? sessionId(lead) : null;
  useEffect(() => {
    const next = followedSession(data.entries, leadId, Date.now());
    const nextId = next ? sessionId(next) : null;
    if (nextId !== heldLead) return setHeldLead(nextId);
    if (!lead || lead.row.running || data.entries.length < 2) return;
    const wait = lead.row.lastCallAt + FOLLOW_HOLD_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setHoldTick((n) => n + 1), wait + 16);
    return () => clearTimeout(timer);
  }, [data.entries, heldLead, holdTick, lead, leadId]);
  const stream = useLiveStream(lead, !pinnedRow && paneShown && docShown, box, root);
  const over = stream.state.status === "ended" || stream.state.status === "failed";

  // ── kept pictures and read texts ──
  const [cache] = useState(() => new StepMediaCache({ read: readHistoryStep, onPictureGone: markPictureGone }));
  useEffect(() => () => cache.clear(), [cache]);
  // a history that was removed, or removed and begun again, shows nothing of what it was: its kept media goes,
  // and a row pinned in it is no pin (the new history's call of that number is another call)
  const bornOf = (key: string): number => data.histories[key]?.born ?? 0;
  const births = useRef(new Map<string, number>());
  useEffect(() => {
    for (const { key } of data.keys) {
      const born = data.histories[key]?.born ?? 0;
      const was = births.current.get(key);
      if (was !== undefined && was !== born) {
        cache.dropKey(key);
        if (latest.current.pinnedRow?.key === key) {
          setSelected(null);
          setKeptHeight(null);
        }
      }
      births.current.set(key, born);
    }
  }, [cache, data.histories, data.keys]);

  // With nothing live, or the stream over, a kept step stands in for the window: the newest one, or where that kept
  // nothing (a call that was stopped, refused, or only listed apps) the newest that did. With Screen Recording off
  // it is the lead session's newest read, whose text is what there is to see.
  const noRecording = stream.state.status === "ended" && stream.state.reason === "permission";
  const leadKey = lead ? historyKeyOf(lead) : null;
  const standIn = (): StepRow | null => {
    if (noRecording) {
      const read = rows.find((r) => r.call.text && r.key === leadKey) ?? rows.find((r) => r.call.text);
      if (read) return read;
    }
    // Under a session's row whose preview ended, that session's own newest kept step: the newest step of the
    // tree may be another session's, in another window.
    const own = lead ? rows.find((r) => r.key === leadKey && keepsMedia(r.call)) : undefined;
    if (own) return own;
    if (!openRow || keepsMedia(openRow.call)) return openRow;
    // the open step's own session first: its window is the one the step was in
    return rows.find((r) => r.key === openRow.key && keepsMedia(r.call)) ?? rows.find((r) => keepsMedia(r.call)) ?? openRow;
  };
  const shownRow = pinnedRow ?? (!lead || over ? standIn() : null);
  // What the stand-in is measured against: the followed session's window while one is live, else the open step's.
  const another =
    !pinnedRow && shownRow !== null
      ? lead
        ? shownRow.key !== leadKey
        : openRow !== null && (shownRow.key !== openRow.key || shownRow.call.app !== openRow.call.app || shownRow.call.window !== openRow.call.window)
      : false;
  const asOf = pinnedRow ? lead !== null : shownRow !== null && (another || shownRow.call !== openRow?.call);
  const shownWant = wantOf(shownRow, bornOf);
  const media = useStepMedia(cache, shownWant);

  // The open row's read: closed whenever the open row changes.
  const [readFor, setReadFor] = useState<string | null>(null);
  if (readFor !== null && readFor !== (openRow?.id ?? null)) setReadFor(null);
  const readRow = openRow !== null && readFor === openRow.id ? openRow : null;
  const readOpen = readRow !== null;
  const readWant = wantOf(readRow, bornOf);
  const readMedia = useStepMedia(cache, readWant);
  // the text held for the call stays while a later revision of it (its picture landing) is read
  const readText = readWant && readMedia.landed?.id === readWant.id ? (readMedia.landed.media.text ?? "") : null;

  // The rows' handlers read what is current through a ref, so they keep one identity and a push re-renders only the
  // row whose call changed (docs/agents/renderer-over-time.md).
  const latest = useRef({ rows, pinnedRow, openRow });
  useLayoutEffect(() => {
    latest.current = { rows, pinnedRow, openRow };
  });
  const onSelect = useCallback(
    (id: string) => {
      const { rows, pinnedRow } = latest.current;
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return;
      // the box keeps the height it has now for as long as a row is pinned
      if (!pinnedRow) setKeptHeight(box.current?.getBoundingClientRect().height || null);
      setSelected(id);
      // the rows either side are a key away
      for (const near of [rows[at - 1], rows[at + 1]]) if (near && near.call !== rows[at].call && keepsMedia(near.call)) void cache.load(near.key, near.call).catch(() => undefined);
    },
    [cache],
  );
  const onFollow = useCallback(() => {
    setSelected(null);
    setKeptHeight(null);
  }, []);
  const onToggleRead = useCallback(() => {
    const { openRow, pinnedRow } = latest.current;
    if (!openRow) return;
    // opening the read is choosing its row: it stays open, and its text with it, while more steps land
    if (!pinnedRow) onSelect(openRow.id);
    setReadFor((was) => (was !== openRow.id ? openRow.id : null));
  }, [onSelect]);

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
  // The rows stand in the order their sessions began, so a Stop never moves under the pointer; the followed one
  // is drawn last, right above the box.
  const live = useMemo<LiveSession[]>(
    () =>
      [...data.entries]
        .sort((a, b) => Number(sessionId(a) === leadId) - Number(sessionId(b) === leadId) || a.row.since - b.row.since)
        .map((e) => ({ id: sessionId(e), label: computerLabel(e), stopping: stopping.has(sessionId(e)) })),
    [data.entries, leadId, stopping],
  );
  // The running lines keep their order as the sessions take turns: the followed session's first, next to the box,
  // then the others as they began.
  const running = useMemo(
    () => runningLines([...data.entries].sort((a, b) => Number(sessionId(b) === leadId) - Number(sessionId(a) === leadId) || a.row.since - b.row.since), list),
    [data.entries, leadId, list],
  );

  // ── the journal's own state ──
  const keysId = data.keys.map((k) => k.key).join("\n");
  const keys = useMemo(() => (keysId ? keysId.split("\n") : []), [keysId]);
  const histories = keys.map((key) => data.histories[key]);
  const status = histories.some((h) => h?.status === "failed") ? "failed" : histories.some((h) => !h || h.status === "loading") && rows.length === 0 ? "loading" : "ready";
  const [loadingMore, setLoadingMore] = useState(false);
  const onOlder = useCallback(() => {
    setLoadingMore(true);
    // a page that cannot be read says so; the rows held and the button stay, and the button asks again
    void Promise.all(keys.filter((key) => data.histories[key]?.more).map((key) => loadOlderHistory(key)))
      .catch(() => loadToast().then((toast) => toast.error("Couldn't read the earlier steps")))
      .finally(() => setLoadingMore(false));
  }, [data.histories, keys]);
  const onRetry = useCallback(() => retryHistory(keys), [keys]);

  const viewport = viewportOf({
    live: lead ? { entry: lead, stream } : null,
    pinned: pinnedRow,
    shown: shownRow,
    ...(shownWant ? { shownId: shownWant.id } : {}),
    media,
    keptHeight,
    asOf,
    another,
    // a kept picture opens the lightbox from the box; the live box does not
    onOpen: (label, url, from) => openLightbox([{ environmentId: LOCAL_ENVIRONMENT_ID, name: label, src: url }], 0, from),
  });

  return (
    <ComputerView
      ref={root}
      boxRef={box}
      sessions={live}
      followedId={leadId}
      pinned={pinnedRow !== null}
      viewport={viewport}
      running={running}
      groups={list.groups}
      openId={openRow?.id ?? null}
      followId={followRow?.id ?? null}
      read={{
        open: readOpen,
        text: readText,
        above: viewport?.face?.kind === "text" && shownRow?.call === openRow?.call,
        ...(readOpen && readText === null && readMedia.failed ? { failed: true, onRetry: readMedia.retry } : {}),
      }}
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
