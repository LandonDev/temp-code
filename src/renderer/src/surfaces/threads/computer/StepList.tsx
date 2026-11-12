import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { ComputerHistoryStep, ComputerStepKind } from "@server/shared/contract-computer";
import { workingStep } from "@server/shared/computer/historyWords";
import { COMPUTER_TIER_WORDS } from "@server/shared/statusWords";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Collapsible, CollapsibleContent, DISCLOSURE_CHEVRON } from "@renderer/components/ui/collapsible";
import { CONSOLE } from "@renderer/components/ui/console";
import { ROW_PRESS } from "@renderer/components/ui/press";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusMark } from "@renderer/components/ui/status";
import { TruncateTip } from "@renderer/components/tip";
import { cn } from "@renderer/lib/cn";
import { AppWindow, Camera, ChevronRight, Hourglass, Keyboard, Minus, MousePointerClick, MoveVertical, ScanText, TextCursor, type IconComponent } from "../../../chrome/icons";
import type { StepGroup, StepRow } from "../../../lib/computerHistory";
import { clockTime } from "../../../lib/duration";
import { STAGGER } from "../../../lib/ease";
import { SwapIcon } from "../../../motion/IconSwap";
import { Facts } from "../../settings/hosts/Facts";
import { GLYPH_SLOT, STEP_LINE } from "../../transcript/stepLine";

/**
 * The Computer section's steps (docs/DESIGN.md "Panels"): the call that runs
 * now as one line, then every finished step of the thread, newest first, one
 * 28px row each on the transcript's step grid, grouped by turn. One row is
 * open: the last step that finished while the section follows, else the one
 * the person chose. It carries its facts (the tier in the house's words, what
 * it acted on, how it went, its time), what the model read and, for a step
 * that failed, why. The words are the host's, made once (the journal's): a
 * step that ran reads in the past ("Clicked Save"), one that failed, was
 * stopped or never ran as what was asked ("Click Save"). A step that lands
 * at the top while the section follows fades in and rises 4px; nothing
 * moves on a key, while a row is pinned, at mount, or for a page of earlier
 * steps.
 */

/** A step's glyph by its kind, uncoloured; a state takes its place. */
const KIND_GLYPH: Record<ComputerStepKind, IconComponent> = {
  click: MousePointerClick,
  type: TextCursor,
  key: Keyboard,
  scroll: MoveVertical,
  read: ScanText,
  look: Camera,
  wait: Hourglass,
  app: AppWindow,
};

/** The row's inset, and where its words start: 8px, the 14px glyph, 8px. */
const ROW_INSET = "px-2";
const WORDS_COLUMN = "ps-[30px] pe-2";

/** The call that runs now, as the list's top line. */
export interface RunningLine {
  id: string;
  /** working's still dot, the amber mark while a card waits, the dashed ring while held */
  state: "working" | "waiting" | "queued";
  /** muted, then the object in foreground; a card's question or a hold's line is the object alone */
  verb: string;
  object: string;
  /** a batch's planned steps, in the card's words */
  plan?: readonly string[];
  /** a held step: what waits */
  waits?: string;
}

/** What the open row says of its read: closed, or open on its text (null while it is on its way). */
export interface ReadFold {
  open: boolean;
  text: string | null;
  /** the viewport above already shows this text: the line says what was read and opens nothing */
  above?: boolean;
  /** the text's read failed: said in the console's place, with Retry */
  failed?: boolean;
  onRetry?: () => void;
}

/**
 * A row's words: its own without the app, or with it where the row names its
 * app or has nothing else to say. `live` is a call that runs; `waits` one
 * that is held before it began, which reads as what is asked ("Press ⌘S").
 */
export function rowWords(row: Pick<StepRow, "step" | "namesApp" | "whole" | "call">, live = false, waits = false): { verb: string; object: string } {
  // a batch that runs, or never finished, is its call as one row: "Working in Mail", or what was asked, "Work in Mail"
  const whole = row.whole && row.call.steps.length > 1;
  const step: ComputerHistoryStep = whole ? workingStep(row.call.app, live && !waits ? "live" : "asked") : waits && row.step.asked ? { ...row.step, ...row.step.asked } : row.step;
  return { verb: step.verb, object: row.namesApp || !step.object ? step.inApp : step.object };
}

function Words({ verb, object, quiet, whole }: { verb: string; object: string; quiet?: boolean; /** said whole, wrapping, never cut */ whole?: boolean }) {
  return (
    <>
      {verb ? <span className="shrink-0 text-muted-foreground">{verb}</span> : null}
      {object ? <span className={cn("min-w-0", !whole && "truncate", quiet ? "text-muted-foreground" : "text-foreground")}>{object}</span> : null}
    </>
  );
}

/** A line that says its words whole: the step grid's height as a minimum, the glyph on its first line. */
const WHOLE_LINE = "flex min-h-7 min-w-0 items-start gap-1 py-1 font-sans text-[13px] leading-5";

/** How a finished row ended, as its mark: nothing for a step that ran; a dash for one that never did. */
type RowMark = "failed" | "stopped" | "not-run" | null;
const markOf = (row: StepRow): RowMark =>
  row.call.state === "unfinished" || row.step.state === "stopped" ? "stopped" : row.step.state === "failed" ? "failed" : row.step.state === "not-run" ? "not-run" : null;

function RowGlyph({ kind, mark }: { kind: ComputerStepKind; mark: RowMark }) {
  const Glyph = KIND_GLYPH[kind];
  return (
    <span className={GLYPH_SLOT} data-slot="step-glyph" data-mark={mark ?? undefined}>
      {mark === "not-run" ? <Minus className="size-3.5" /> : mark ? <StatusMark state={mark} word={false} aria-hidden /> : <Glyph className="size-3.5" />}
    </span>
  );
}

/** The running call: one line, its state in the glyph's place, and under it a batch's plan or what a held step waits to do. */
function RunningRow({ line, pinned, onFollow }: { line: RunningLine; pinned: boolean; onFollow: () => void }) {
  // A card's question and a hold's line are for the person: said whole, wrapping where the pane is narrow.
  const whole = line.state !== "working";
  const head = (
    <>
      <span className="flex h-5 shrink-0 items-center">
        <span className={GLYPH_SLOT} data-slot="step-glyph">
          <SwapIcon state={line.state}>
            <StatusMark state={line.state} word={false} still aria-hidden />
          </SwapIcon>
        </span>
      </span>
      <Words verb={line.verb} object={line.object} whole={whole} />
    </>
  );
  const lineClass = cn(whole ? WHOLE_LINE : STEP_LINE, ROW_INSET);
  return (
    <div data-slot="step-running" data-state={line.state}>
      {pinned ? (
        // While a row is pinned the running line is a way back to the live window.
        <button type="button" aria-label={`Follow the live window: ${[line.verb, line.object].filter(Boolean).join(" ")}`} onClick={onFollow} className={cn(lineClass, ROW_PRESS, "w-full rounded-lg text-start")}>
          {head}
        </button>
      ) : (
        <div data-slot="step-line" className={lineClass}>
          {head}
        </div>
      )}
      {line.waits || line.plan?.length ? (
        // what a held step waits to do, or a batch's planned steps, one a line: a step's own words hold commas
        <div className={cn(WORDS_COLUMN, "pb-1 text-xs leading-4 text-muted-foreground")} data-slot="step-plan">
          {(line.waits ? [line.waits] : (line.plan ?? [])).map((words, i) => (
            <span key={i} className="block">
              {words}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The lines of the read text, the ones that name the acted element in foreground. */
function ReadText({ text, element }: { text: string; element?: number }) {
  const box = useRef<HTMLPreElement>(null);
  const acted = element === undefined ? null : new RegExp(`^\\s*(?:[-~+] )?\\[${element}\\](?:\\s|$)`);
  // The acted line comes into view inside the console alone: the list around it never scrolls for it.
  useLayoutEffect(() => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>("[data-acted]");
    if (el && line) el.scrollTop = Math.max(0, line.offsetTop - el.clientHeight / 2);
  }, [text, element]);
  return (
    <pre ref={box} tabIndex={0} aria-label="What was read" data-slot="step-read-text" className={cn(CONSOLE, "m-0 mt-1 max-h-60 overflow-x-auto overflow-y-auto whitespace-pre")}>
      {text.split("\n").map((line, i) => {
        const hit = acted?.test(line) === true;
        return (
          <span key={i} data-acted={hit || undefined} className={cn("block", hit && "text-foreground")}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

/** What opens under the open row, on its words' column: why it failed or stopped, its facts, what the model read. */
function StepDetail({ row, read, onToggleRead }: { row: StepRow; read: ReadFold; onToggleRead: () => void }) {
  const { step, call } = row;
  const unfinished = call.state === "unfinished";
  const state = unfinished ? "stopped" : step.state;
  // why: red for a step that failed; a stop is the person's or the turn's own, said plainly
  const why = unfinished ? "Didn't finish" : state === "not-run" ? "Not run" : state === "failed" || state === "stopped" ? (step.reason ?? (state === "failed" ? "Failed" : "Stopped")) : null;
  const facts: ReactNode[] = unfinished
    ? [clockTime(call.at)]
    : [step.tier ? COMPUTER_TIER_WORDS[step.tier] : null, step.target, ...(step.facts ?? []), clockTime(call.endedAt ?? call.at)];
  // the call's read belongs to the last step that was tried: the closing read came after it, never after a step
  // that did not run. A read's own row already says Read, so its line is what it took in alone: "41 elements".
  const tried = call.steps.findLastIndex((s) => s.state !== "not-run");
  const took = !unfinished && row.index === (tried < 0 ? call.steps.length - 1 : tried) ? call.read : undefined;
  const reads = took && step.kind === "read" ? took.replace(/^Read (.)/, (_, first: string) => (/\d/.test(first) ? first : first.toUpperCase())) : took;
  return (
    <div className={cn(WORDS_COLUMN, "flex flex-col gap-1 pb-2 text-xs leading-4")} data-slot="step-detail">
      {why ? (
        <p data-slot="step-why" className={cn("m-0", state === "failed" ? "text-destructive" : state === "not-run" ? "text-muted-foreground" : "text-foreground")}>
          {why}
        </p>
      ) : null}
      <Facts parts={facts} className="text-muted-foreground" />
      {reads ? (
        call.text && !read.above ? (
          <Collapsible open={read.open}>
            <button
              type="button"
              data-slot="step-read"
              aria-expanded={read.open}
              onClick={onToggleRead}
              // the words and the chevron lift to foreground at once, with no fill; the turn is the one thing that moves
              // (a 24px target on a 16px line: its box hangs 4px over the lines above and below)
              className="-my-1 flex max-w-full items-center gap-1 rounded-sm py-1 text-start text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <span className="min-w-0 truncate">{reads}</span>
              <ChevronRight className={cn("ms-1 size-3 shrink-0", DISCLOSURE_CHEVRON, read.open && "rotate-90")} />
            </button>
            <CollapsibleContent>
              {read.failed ? (
                <p role="alert" data-slot="step-read-failed" className="m-0 mt-1 flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                  <span>Couldn't read the text</span>
                  <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={read.onRetry}>
                    Retry
                  </Button>
                </p>
              ) : read.text === null ? (
                <div role="status" aria-busy aria-label="Loading what was read" className={cn(CONSOLE, "mt-1 flex flex-col gap-2")}>
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ) : (
                <ReadText text={read.text} element={step.element} />
              )}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <span data-slot="step-read" className="text-muted-foreground">
            {reads}
          </span>
        )
      ) : null}
    </div>
  );
}

interface RowProps {
  row: StepRow;
  open: boolean;
  /** the list's one tab stop */
  tabbable: boolean;
  /** its place among the rows that landed with it; undefined for one that was there, or came while a row was pinned */
  stagger?: number;
  read: ReadFold | null;
  onSelect: (id: string) => void;
  onToggleRead: () => void;
}

/** One finished step. A push re-renders the one row whose call changed: the others keep their call's object. */
const StepRowView = memo(
  function StepRowView({ row, open, tabbable, stagger, read, onSelect, onToggleRead }: RowProps) {
    const words = rowWords(row);
    const mark = markOf(row);
    const quiet = row.step.state === "not-run";
    // The mark is drawn, not said: the row's name carries how the step ended, so it is heard as it is seen.
    const said = [words.verb, words.object].filter(Boolean).join(" ");
    const outcome = row.call.state === "unfinished" ? "didn't finish" : mark === "not-run" ? "not run" : mark;
    return (
      <div
        data-slot="step"
        data-step={row.id}
        data-open={open || undefined}
        className={cn("min-w-0 rounded-lg", open && "bg-muted", stagger !== undefined && "step-land")}
        style={stagger !== undefined ? ({ "--stagger": stagger } as CSSProperties) : undefined}
      >
        <button
          type="button"
          data-row={row.id}
          aria-current={open ? "true" : undefined}
          aria-label={outcome ? `${said}, ${outcome}` : undefined}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => onSelect(row.id)}
          className={cn(STEP_LINE, ROW_INSET, "w-full rounded-lg text-start", open ? "" : ROW_PRESS)}
        >
          <RowGlyph kind={row.whole && row.call.steps.length > 1 ? "click" : row.step.kind} mark={mark} />
          {open ? (
            // the open row says its words whole on hover when they are cut
            <TruncateTip text={said}>
              <span className="flex min-w-0 items-center gap-1">
                <Words {...words} quiet={quiet} />
              </span>
            </TruncateTip>
          ) : (
            <Words {...words} quiet={quiet} />
          )}
        </button>
        {open && read ? <StepDetail row={row} read={read} onToggleRead={onToggleRead} /> : null}
      </div>
    );
  },
  (a, b) =>
    a.row.call === b.row.call &&
    a.row.index === b.row.index &&
    a.row.namesApp === b.row.namesApp &&
    a.open === b.open &&
    a.tabbable === b.tabbable &&
    a.stagger === b.stagger &&
    a.read?.open === b.read?.open &&
    a.read?.text === b.read?.text &&
    a.read?.above === b.read?.above &&
    a.read?.failed === b.read?.failed &&
    a.read?.onRetry === b.read?.onRetry &&
    a.onSelect === b.onSelect &&
    a.onToggleRead === b.onToggleRead,
);

/** A row's id inside a quoted attribute selector (a key may hold any character). */
const quoted = (id: string): string => id.replace(/["\\]/g, "\\$&");

/** The rows' shape while the first read is out. */
function RowsSkeleton() {
  return (
    <div role="status" aria-busy aria-label="Loading the steps" data-slot="steps-loading">
      {["w-2/5", "w-3/5", "w-1/3"].map((width) => (
        <div key={width} className={cn(STEP_LINE, ROW_INSET)}>
          <span className={GLYPH_SLOT}>
            <Skeleton className="size-3.5 rounded-sm" />
          </span>
          <Skeleton className={cn("h-3", width)} />
        </div>
      ))}
    </div>
  );
}

/**
 * The list's keys, JumpList's model on a list of its own: ↑ the newer row,
 * ↓ the older, Home the live end, End the oldest loaded. Focus goes with the
 * choice, and nothing animates.
 */
export function useStepKeys(opts: {
  ids: readonly string[];
  openId: string | null;
  /** the row that is open once the section follows again: the newest step with an outcome */
  followId?: string | null;
  scroller: RefObject<HTMLElement | null>;
  onSelect: (id: string) => void;
  onFollow: () => void;
}) {
  const { ids, openId, followId, scroller, onSelect, onFollow } = opts;
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !ids.length) return;
      // a key inside the read text is the text's own
      if ((e.target as HTMLElement).closest("pre")) return;
      const at = openId ? ids.indexOf(openId) : -1;
      let next: string | "live" | null = null;
      if (e.key === "ArrowDown") next = ids[Math.min(ids.length - 1, at + 1)] ?? null;
      else if (e.key === "ArrowUp") next = at <= 0 ? "live" : ids[at - 1];
      else if (e.key === "Home") next = "live";
      else if (e.key === "End") next = ids[ids.length - 1];
      if (next === null) return;
      e.preventDefault();
      // the live end's open row is the tab stop there: the focus goes to it, not to a step above it that never ran
      const id = next === "live" ? (followId ?? ids[0]) : next;
      if (next === "live") onFollow();
      else if (next !== openId) onSelect(next);
      // after the commit the row is the tab stop: focus goes there without scrolling the list twice
      requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-row="${quoted(id)}"]`)?.focus());
    },
    [followId, ids, onFollow, onSelect, openId, scroller],
  );
}

export interface StepListProps {
  running: readonly RunningLine[];
  groups: readonly StepGroup[];
  /** the open row: the pinned one, else the newest finished step */
  openId: string | null;
  /** the row that is open while the section follows */
  followId?: string | null;
  /** a row was chosen by hand */
  pinned: boolean;
  read: ReadFold;
  status: "loading" | "ready" | "failed";
  /** older steps exist on the host */
  more: boolean;
  loadingMore?: boolean;
  onSelect: (id: string) => void;
  onFollow: () => void;
  onToggleRead: () => void;
  onRetry: () => void;
  onOlder: () => void;
}

/** The pinned row's top inside the scroller. */
const topOf = (el: HTMLElement): number => el.offsetTop;

/** The list counts as at its top within this many pixels: there it stays as steps land. */
const AT_TOP = 4;

/** The read that failed, said once with its way back: above whatever steps and running lines there still are. */
function FailedLine({ onRetry, className }: { onRetry: () => void; className: string }) {
  return (
    <p data-slot="steps-failed" className={cn("m-0 flex flex-wrap items-baseline gap-x-2 text-xs leading-4 text-destructive", className)}>
      <span>Couldn't read the steps</span>
      <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onRetry}>
        Retry
      </Button>
    </p>
  );
}

export function StepList({ running, groups, openId, followId, pinned, read, status, more, loadingMore, onSelect, onFollow, onToggleRead, onRetry, onOlder }: StepListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
  const idsKey = ids.join("|");

  // Rows that land in one commit fade in one after another, STAGGER.stepMs apart, the fourth and later together.
  // The map holds the rows on screen and each one's place; a row never lands (its place is -1) when it was there at
  // mount, came with the first read, came while a row was pinned, or is a page of earlier steps under the rows
  // already here: only a step that arrives at the live end is news.
  const [landed, setLanded] = useState<ReadonlyMap<string, number>>(() => new Map(ids.map((id) => [id, -1])));
  const [armed, setArmed] = useState(status === "ready");
  useEffect(() => {
    if (status === "ready") setArmed(true);
  }, [status]);
  const fresh = ids.filter((id) => !landed.has(id));
  if (fresh.length > 0 || landed.size > ids.length) {
    const firstHeld = ids.findIndex((id) => landed.has(id));
    const next = new Map<string, number>();
    for (const id of ids) {
      const place = landed.get(id);
      if (place !== undefined) next.set(id, place);
    }
    const atTop = fresh.filter((id) => firstHeld < 0 || ids.indexOf(id) < firstHeld);
    // newest first on screen: the first of a batch is its last row, so the batch lands in the order it ran
    atTop.reverse().forEach((id, i) => next.set(id, pinned || !armed ? -1 : Math.min(i, STAGGER.max)));
    for (const id of fresh) if (!next.has(id)) next.set(id, -1);
    setLanded(next);
  }

  // While a row is pinned, rows that land above it do not move it: the list scrolls on by their height, from 0 too.
  // The offset is that row's own: choosing another row starts again from where the new one stands.
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const row = pinned && openId ? el?.querySelector<HTMLElement>(`[data-step="${quoted(openId)}"]`) : null;
    if (!el || !row || !openId) {
      anchor.current = null;
      return;
    }
    const top = topOf(row);
    if (anchor.current?.id === openId && top !== anchor.current.top) el.scrollTop += top - anchor.current.top;
    anchor.current = { id: openId, top };
  }, [idsKey, openId, pinned, running.length]);

  // Following, a list at its top stays there as steps land: the live end. One the person scrolled keeps its place
  // (so does a page of earlier steps they asked for); following again, by Go live or Home, goes back to the top.
  const atTop = useRef(true);
  const wasPinned = useRef(pinned);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !pinned && (wasPinned.current || atTop.current)) {
      el.scrollTop = 0;
      atTop.current = true;
    }
    wasPinned.current = pinned;
  }, [idsKey, pinned]);

  // Following, the open row is in view: after a batch that failed with a long tail of steps that never ran, the
  // step that failed is what the person came to see. The newest row is the top, where the list already is.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || pinned || !openId || openId === ids[0] || !atTop.current) return;
    const row = el.querySelector<HTMLElement>(`[data-step="${quoted(openId)}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, pinned]);

  const onKeyDown = useStepKeys({ ids, openId, followId, scroller, onSelect, onFollow });

  if (status === "failed" && !ids.length && !running.length) return <FailedLine onRetry={onRetry} className="px-3 py-2" />;

  return (
    // The keys are the rows': the list hears them where they bubble.
    <div
      ref={scroller}
      data-slot="computer-steps"
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        atTop.current = e.currentTarget.scrollTop <= AT_TOP;
      }}
      className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pb-3"
    >
      {status === "failed" ? <FailedLine onRetry={onRetry} className="px-2 pb-2" /> : null}
      {running.map((line) => (
        <RunningRow key={line.id} line={line} pinned={pinned} onFollow={onFollow} />
      ))}
      {status === "loading" && !ids.length ? <RowsSkeleton /> : null}
      {groups.map((group, g) => (
        // groups sit 16px apart; a first group with a heading (a subagent's) stands 8px off the running lines above it
        <section key={group.id} data-slot="step-group" aria-label={group.heading ? groupName(group.heading) : "Latest steps"} className={g > 0 ? "mt-4" : group.heading && running.length ? "mt-2" : undefined}>
          {group.heading ? (
            <h3 data-slot="step-heading" className={cn(ROW_INSET, "m-0 flex min-w-0 items-baseline gap-1 pb-1 text-xs leading-4 font-medium text-muted-foreground")}>
              {group.heading.title ? <span className="min-w-0 truncate">{group.heading.title}</span> : null}
              {/* beside a title the time is the lighter of the two facts */}
              <span className={cn("shrink-0 tabular-nums", group.heading.title && "font-normal")}>{clockTime(group.heading.at)}</span>
            </h3>
          ) : null}
          {group.rows.map((row) => {
            const open = row.id === openId;
            const place = landed.get(row.id);
            return (
              <StepRowView
                key={row.id}
                row={row}
                open={open}
                tabbable={open || (openId === null && row.id === ids[0])}
                stagger={place !== undefined && place >= 0 ? place : undefined}
                read={open ? read : null}
                onSelect={onSelect}
                onToggleRead={onToggleRead}
              />
            );
          })}
        </section>
      ))}
      {more ? (
        // on the words' column, its own inset hung outside it so its words line up with the rows'
        <div className={cn(WORDS_COLUMN, "pt-2")}>
          <Button variant="ghost" size="xs" data-slot="steps-older" className="-ms-2 text-muted-foreground hover:text-foreground" disabled={loadingMore} onClick={onOlder}>
            <BusyLabel busy={!!loadingMore} label="Show earlier steps" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const groupName = (heading: { at: number; title?: string }): string => (heading.title ? `${heading.title}, ${clockTime(heading.at)}` : `Steps from ${clockTime(heading.at)}`);
