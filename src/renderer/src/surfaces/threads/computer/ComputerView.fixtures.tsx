// Every state of the Computer section, for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/ComputerView.preview.tsx#ComputerStates`
// and the dom test that keeps them honest. The pictures and read texts are the
// recorded app fixtures (src/main/server/computer/fixtures/apps): scratch
// content only. Each entry is what ComputerView is given, so a state here is
// a state the section can draw.
import type { ReactNode } from "react";
import type { ComputerHistoryCall, ComputerHistoryStep } from "@server/shared/contract-computer";
import { flatRows, rowsOf, type HistorySession } from "../../../lib/computerHistory";
import type { ComputerViewProps, LiveSession } from "./ComputerView";
import type { RunningLine } from "./StepList";
import { ClickMark, ViewportLine, pictureClass, type ViewportProps } from "./Viewport";

const still = (app: string, state: string): string => new URL(`../../../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const TEXTEDIT = { width: 1206, height: 1010 };
const CHROME = { width: 930, height: 1280 };
const FINDER = { width: 1200, height: 800 };

/** 2:04 PM on the day the fixtures were written, in whatever zone renders them. */
const AT = new Date(2026, 10, 11, 14, 4, 0).getTime();
const MIN = 60_000;

const noop = (): void => {};
const step = (kind: ComputerHistoryStep["kind"], verb: string, object: string, over: Partial<ComputerHistoryStep> = {}, app = "TextEdit"): ComputerHistoryStep => ({
  kind,
  verb,
  object,
  inApp: object ? `${object} in ${app}` : kind === "read" || kind === "look" ? app : `in ${app}`,
  state: "ok",
  ...(kind === "read" || kind === "look" || kind === "app" ? {} : { tier: "ax" as const }),
  ...over,
});
let n = 0;
const call = (at: number, steps: ComputerHistoryStep[], over: Partial<ComputerHistoryCall> = {}): ComputerHistoryCall => ({
  n: ++n,
  turn: 1,
  at,
  endedAt: at + 900,
  state: "done",
  app: "TextEdit",
  window: "Untitled",
  steps,
  text: false,
  picture: { ...TEXTEDIT, at: at + 950 },
  rev: 3,
  ...over,
});

// ── a run in TextEdit: read, click, type, save ──

const READ_DOC = [
  'app "TextEdit" · window "Untitled" · 1206×1010 · focused [3]',
  '[1] window "Untitled"',
  "  [2] scroll area",
  '    [3] text area = "Hello from the probe\\nSecond line!" focused selection 15..20 actions: show menu',
  "    [4] ruler actions: press",
  "      [5]–[19] 15 × ruler marker",
  '  [20] group "Formatting"',
  '    [21] checkbox "bold" unchecked',
  '    [22] checkbox "italic" unchecked',
  '    [23] checkbox "underline" unchecked',
  '    [27] pop up "typeface" = "Helvetica"',
  '    [29] combo box "font size" = "12" actions: confirm',
  '  [39] button "close"',
  '  [40] button "minimize"',
  '  [41] button "full screen" actions: zoom window, show menu',
].join("\n");

const READ_SHEET = [
  'app "TextEdit" · window "Untitled" · 1206×1010 · changes since your last read',
  '~ [3] text area = "Hello from the probe\\nSecond line!" actions: show menu',
  '~ [39] button "close" disabled',
  "+ in [1]:",
  '  [42] sheet "save"',
  '    [44] pop up "Where:" = "Documents"',
  '    [46] text = "Do you want to keep this new document “Untitled”?" actions: show menu',
  '    [48] input "Save As:" = "Untitled.rtf" actions: show menu, confirm',
  '    [51] pop up "File Format:" = "Rich Text Document"',
  '    [52] button "Delete"',
  '    [53] button "Cancel"',
  '    [54] button "Save"',
].join("\n");

const read = call(AT - 3 * MIN, [step("read", "Read", "")], { read: "Read 41 elements", text: true });
const clicked = call(AT - 2 * MIN - 30_000, [step("click", "Clicked", "a text area", { target: "at 412, 300" })], { read: "Read no changes" });
const typed = call(AT - 2 * MIN, [step("type", "Typed", "into a text area", { kind: "type", target: '"Second line!"', element: 3 })], { read: "Read 1 change", text: true });
const pressed = call(AT - MIN, [step("key", "Pressed", "super+s", { tier: "front", facts: ["through the menu File › Save…", "opened the save sheet"] })], { read: "Read 5 changes", text: true });
const typedName = call(AT - 20_000, [step("type", "Typed", "into Save As", { target: '"Total"', element: 48 })], { read: "Read 2 changes", text: true });
const run = [read, clicked, typed, pressed, typedName];

const live: LiveSession = { id: "local:t1", label: "Untitled in TextEdit" };

/** The list and the open row for these calls of the thread on screen. */
function listOf(sessions: HistorySession[], open?: (ids: string[]) => string): Pick<ComputerViewProps, "groups" | "openId"> {
  const list = rowsOf(sessions);
  const ids = flatRows(list).map((r) => r.id);
  return { groups: list.groups, openId: open ? open(ids) : (ids[0] ?? null) };
}
const own = (calls: ComputerHistoryCall[]): HistorySession[] => [{ key: "t1", threadId: "t1", calls }];

const frame = (app: string, state: string): ReactNode => <img src={still(app, state)} alt="" className={pictureClass(true)} />;
const liveBox = (app: string, state: string, size: { width: number; height: number }, over: Partial<ViewportProps> = {}): ViewportProps => ({
  face: { kind: "live", picture: frame(app, state), drawn: true },
  label: "Live view of Untitled in TextEdit",
  size,
  frames: 12,
  ...over,
});
const kept = (app: string, state: string, size: { width: number; height: number }, at: string, over: Partial<ViewportProps> = {}): ViewportProps => ({
  face: { kind: "picture", src: still(app, state), onOpen: noop },
  label: `Untitled in TextEdit at ${at}`,
  size,
  ...over,
});

const base = (over: Partial<ComputerViewProps>): ComputerViewProps => ({
  sessions: [],
  pinned: false,
  viewport: null,
  running: [],
  groups: [],
  openId: null,
  read: { open: false, text: null },
  status: "ready",
  more: false,
  onSelect: noop,
  onFollow: noop,
  onStop: noop,
  onToggleRead: noop,
  onRetry: noop,
  onOlder: noop,
  ...over,
});

const working = (verb: string, object: string, over: Partial<RunningLine> = {}): RunningLine => ({ id: "running:local:t1", state: "working", verb, object, ...over });

export interface ComputerFixture {
  name: string;
  props: ComputerViewProps;
  /** the pane's height, where the state is about it */
  height?: number;
  /** the pane's widths, where the state is about one */
  widths?: number[];
  /** a pinned box's kept height at each width: what the live box measured when the pin began */
  kept?: Record<number, number>;
}

const batchPlan = ['click button "To"', 'type 6 characters into input "Subject"', "press super+Return"];
const batchDone = call(
  AT - 30_000,
  [
    step("click", "Clicked", "To", { target: 'an input in the "New Message" group' }, "Mail"),
    step("type", "Typed", "into Subject", { kind: "type", target: "6 characters" }, "Mail"),
    step("key", "Pressed", "super+Return", { facts: ["nothing changed"] }, "Mail"),
  ],
  { app: "Mail", window: "New Message", read: "Read 3 changes", text: true },
);
const batchFailed = call(
  AT - 30_000,
  [
    step("click", "Clicked", "To", { target: 'an input in the "New Message" group' }, "Mail"),
    step("type", "Typed", "into Subject", { kind: "type", state: "failed", tier: undefined, reason: "The element was gone", target: "6 characters" }, "Mail"),
    step("key", "Pressed", "super+Return", { state: "not-run", tier: undefined }, "Mail"),
  ],
  { app: "Mail", window: "New Message" },
);

const fixtures: ComputerFixture[] = [
  {
    name: "1. Live, acting: the ring mid-play, the last finished step open with its facts",
    props: base({
      sessions: [live],
      viewport: liveBox("textedit", "save-sheet", TEXTEDIT, { face: { kind: "live", picture: frame("textedit", "save-sheet"), drawn: true, mark: <ClickMark at={[0.62, 0.71]} frozen /> }, marks: 1 }),
      running: [working("Clicking", "Save")],
      ...listOf(own(run)),
    }),
  },
  {
    name: "2. Live, reading",
    props: base({ sessions: [live], viewport: liveBox("textedit", "doc", TEXTEDIT), running: [working("Reading", "TextEdit")], ...listOf(own([read])) }),
  },
  {
    name: "3. Live, a batch running: its planned steps under one line",
    props: base({
      sessions: [{ id: "local:t1", label: "New Message in Mail" }],
      viewport: liveBox("chrome", "form", CHROME, { label: "Live view of New Message in Mail" }),
      running: [working("Working", "in Mail", { plan: batchPlan })],
      ...listOf(own(run)),
    }),
  },
  {
    name: "4. Starting: the skeleton in the stream's shape, no steps yet",
    props: base({ sessions: [live], viewport: { face: { kind: "live", picture: <canvas className={pictureClass(false)} />, drawn: false }, label: "Live view of Untitled in TextEdit", size: null }, running: [working("Reading", "TextEdit")] }),
  },
  {
    name: "5. Held for the person: the Mac not free, and what waits under it",
    props: base({
      sessions: [live],
      viewport: liveBox("textedit", "typed", TEXTEDIT),
      running: [{ id: "running:local:t1", state: "queued", verb: "", object: "Waiting for the Mac to be free, 2nd in line", waits: "Pressing super+s" }],
      ...listOf(own(run.slice(0, 3))),
    }),
  },
  {
    name: "6. Waiting on an approval card: the card's question",
    props: base({
      sessions: [live],
      viewport: liveBox("textedit", "save-sheet", TEXTEDIT),
      running: [{ id: "running:local:t1", state: "waiting", verb: "", object: "Click Save in TextEdit?" }],
      ...listOf(own(run)),
    }),
  },
  {
    name: "7a. A box thread: a card on the Mac",
    props: base({
      sessions: [live],
      viewport: liveBox("textedit", "save-sheet", TEXTEDIT),
      running: [{ id: "running:env_box:b1", state: "waiting", verb: "", object: 'Click button "Save" in TextEdit, window "Untitled"?' }],
      ...listOf(own(run)),
    }),
  },
  {
    name: "7b. A box thread: held in line at the Mac",
    props: base({
      sessions: [live],
      viewport: liveBox("textedit", "typed", TEXTEDIT),
      running: [{ id: "running:env_box:b1", state: "queued", verb: "", object: "Waiting for the Mac, load 12.3 of 8, 3rd in line", waits: "Typing into Save As" }],
      ...listOf(own(run.slice(0, 4))),
    }),
  },
  {
    name: "8. Between calls: no running line, the picture live, the newest step open",
    props: base({ sessions: [live], viewport: liveBox("textedit", "save-sheet", TEXTEDIT), ...listOf(own(run)) }),
  },
  {
    name: "9. A finished step pinned while live: Go live shown, the picture as it was",
    props: base({
      sessions: [live],
      pinned: true,
      viewport: kept("textedit", "typed", TEXTEDIT, "2:02 PM"),
      running: [working("Clicking", "Save")],
      ...listOf(own(run), (ids) => ids[2]),
    }),
  },
  {
    name: "10. A pinned step with its read text open: a diff, the acted lines in foreground",
    props: base({
      sessions: [live],
      pinned: true,
      viewport: kept("textedit", "save-sheet", TEXTEDIT, "2:03 PM"),
      ...listOf(own(run), (ids) => ids[0]),
      read: { open: true, text: READ_SHEET },
    }),
    height: 760,
  },
  {
    name: "11. A failed step: its red line, and the batch's later steps not run",
    props: base({
      viewport: kept("chrome", "form", CHROME, "2:03 PM", { label: "New Message in Mail at 2:03 PM" }),
      ...listOf(own([...run.slice(0, 2), batchFailed]), (ids) => ids[1]),
      pinned: true,
    }),
  },
  {
    name: "12a. Stopped by the person's touch",
    props: base({
      viewport: kept("textedit", "typed", TEXTEDIT, "2:03 PM"),
      ...listOf(own([...run.slice(0, 3), call(AT - 40_000, [step("click", "Clicked", "Save", { state: "stopped", tier: undefined, reason: "Stopped when you used the mouse or keyboard", target: 'a button in the "save" sheet' })], { picture: { none: "no-read" } })])),
    }),
  },
  {
    name: "12b. Stopped by Stop; a call that didn't finish; one refused before it ran",
    props: base({
      viewport: kept("textedit", "typed", TEXTEDIT, "2:03 PM"),
      ...listOf(
        own([
          ...run.slice(0, 2),
          call(AT - 100_000, [step("click", "Clicked", "Save", { state: "failed", tier: undefined, reason: "You didn't allow it", target: 'a button in the "save" sheet' })], { picture: { none: "no-read" } }),
          call(AT - 70_000, [step("key", "Pressing", "super+s", { state: undefined, tier: undefined })], { state: "unfinished", endedAt: undefined, picture: undefined, rev: 1 }),
          call(AT - 40_000, [step("type", "Typed", "into Save As", { state: "stopped", tier: undefined, reason: "Stopped" })], { picture: { none: "no-read" } }),
        ]),
      ),
    }),
  },
  {
    name: "13. Done: history only, two turns, a subagent's group, apps named only where they change",
    props: base({
      viewport: kept("finder", "folder", FINDER, "2:03 PM", { label: "run in Finder at 2:03 PM" }),
      ...listOf([
        {
          key: "t1",
          threadId: "t1",
          calls: [
            ...run.map((c) => ({ ...c, turn: 1, at: c.at - 12 * MIN, endedAt: (c.endedAt ?? c.at) - 12 * MIN })),
            call(AT - 80_000, [step("app", "Launched", "Finder", { inApp: "Finder" })], { turn: 2, app: "", window: null, picture: { none: "no-read" } }),
            call(AT - 60_000, [step("read", "Read", "", {}, "Finder")], { turn: 2, app: "Finder", window: "run", read: "Read 18 elements", text: true, picture: { ...FINDER, at: AT } }),
            call(AT - 40_000, [step("click", "Double-clicked", "Total.txt", { target: 'a row in the "run" outline' }, "Finder")], { turn: 2, app: "Finder", window: "run", read: "Read 2 changes", text: true, picture: { ...FINDER, at: AT } }),
          ],
        },
        {
          key: "sub1",
          threadId: "sub1",
          title: "Fill in the order form",
          calls: [
            call(AT - 6 * MIN, [step("read", "Read", "", {}, "Google Chrome")], { app: "Google Chrome", window: "Computer fixture form", read: "Read 78 elements", text: true, picture: { ...CHROME, at: AT } }),
            call(AT - 5 * MIN, [step("type", "Typed", "into Name", { target: '"Ana"' }, "Google Chrome")], { app: "Google Chrome", window: "Computer fixture form", picture: { ...CHROME, at: AT } }),
          ],
        },
      ]),
    }),
    height: 640,
  },
  {
    name: "14. A run with no pictures: the read text in the viewport, Screen Recording was off",
    props: base({
      viewport: { face: { kind: "text", text: READ_DOC }, label: "Untitled in TextEdit at 2:01 PM", line: <ViewportLine words="Screen Recording was off" /> },
      ...listOf(own([call(AT - 3 * MIN, [step("read", "Read", "")], { read: "Read 41 elements", text: true, picture: { none: "permission" } })])),
    }),
  },
  {
    name: "15. Live with Screen Recording off: the read text and the line that says what to turn on",
    props: base({
      sessions: [live],
      viewport: { face: { kind: "text", text: READ_DOC }, label: "Untitled in TextEdit at 2:01 PM", line: <ViewportLine words="Turn on Screen Recording for TempCode in System Settings" /> },
      running: [working("Clicking", "a text area")],
      ...listOf(own([call(AT - 3 * MIN, [step("read", "Read", "")], { read: "Read 41 elements", text: true, picture: { none: "permission" } })])),
    }),
  },
  {
    name: "16. A thin tree: Looked at the picture",
    props: base({
      viewport: kept("chrome", "not-drawn", CHROME, "2:03 PM", { label: "Computer fixture form in Google Chrome at 2:03 PM" }),
      ...listOf(own([call(AT - MIN, [step("read", "Read", "", {}, "Google Chrome")], { app: "Google Chrome", window: "Computer fixture form", read: "Looked at the picture", picture: { ...CHROME, at: AT } })])),
    }),
  },
  {
    name: "17. A step whose picture is no longer kept and that read nothing: the line alone",
    props: base({
      pinned: true,
      viewport: { face: null, label: "Untitled in TextEdit at 2:01 PM", line: <ViewportLine words="This picture is no longer kept" /> },
      ...listOf(own([call(AT - 3 * MIN, [step("click", "Clicked", "a text area", { target: "at 412, 300" })], { n: 0, picture: { none: "gone" } }), ...run.slice(2)]), (ids) => ids[ids.length - 1]),
    }),
  },
  {
    name: "18a. The preview ended: the window closed, over the newest step's kept picture",
    props: base({ sessions: [live], viewport: kept("textedit", "save-sheet", TEXTEDIT, "2:03 PM", { line: <ViewportLine words="The window closed" /> }), ...listOf(own(run)) }),
  },
  {
    name: "18b. The preview stopped with no step kept: the line alone, with Retry; two sessions",
    props: base({ sessions: [live, { id: "local:sub1", label: "Inbox in Mail" }], viewport: { face: null, label: "", line: <ViewportLine words="The preview stopped" onRetry={noop} /> }, running: [working("Reading", "TextEdit")] }),
  },
  {
    name: "19. A batch's first step pinned: the call's picture, After all 3 steps",
    props: base({
      pinned: true,
      viewport: kept("chrome", "form", CHROME, "2:03 PM", { label: "New Message in Mail at 2:03 PM", line: <ViewportLine words="After all 3 steps" /> }),
      ...listOf(own([...run.slice(0, 2), batchDone]), (ids) => ids[2]),
    }),
  },
  {
    name: "20a. A tall window (930×1280) inside the box",
    props: base({ sessions: [{ id: "local:t1", label: "Computer fixture form in Google Chrome" }], viewport: liveBox("chrome", "form", CHROME, { label: "Live view of Computer fixture form in Google Chrome" }), running: [working("Typing", "into Name")] }),
  },
  {
    name: "20b. A pinned picture of another shape than the live one: the box keeps its height",
    props: base({
      sessions: [live],
      pinned: true,
      viewport: kept("chrome", "form", CHROME, "1:58 PM", { label: "Computer fixture form in Google Chrome at 1:58 PM" }),
      ...listOf(own([call(AT - 6 * MIN, [step("type", "Typed", "into Name", { target: '"Ana"' }, "Google Chrome")], { n: 0, app: "Google Chrome", window: "Computer fixture form", picture: { ...CHROME, at: AT } }), ...run]), (ids) => ids[ids.length - 1]),
    }),
    // the live TextEdit box measured 198px at 260 and 240px at 480 when the pin began
    kept: { 260: 198, 480: 240 },
  },
  {
    name: "21. A password typed: its length only",
    props: base({
      viewport: kept("chrome", "form", CHROME, "2:03 PM", { label: "Sign in in Google Chrome at 2:03 PM" }),
      ...listOf(own([call(AT - MIN, [step("type", "Typed", "into Password", { target: "20 characters" }, "Google Chrome")], { app: "Google Chrome", window: "Sign in", read: "Read 1 change", picture: { ...CHROME, at: AT } })])),
    }),
  },
  {
    name: "22. Two live sessions in one tree: the one that acted last first, each with its own Stop",
    props: base({
      sessions: [{ id: "local:sub1", label: "Computer fixture form in Google Chrome" }, live],
      viewport: liveBox("chrome", "form", CHROME, { label: "Live view of Computer fixture form in Google Chrome" }),
      running: [
        { id: "running:local:sub1", state: "working", verb: "Typing", object: "into Name in Google Chrome" },
        { id: "running:local:t1", state: "working", verb: "Reading", object: "TextEdit" },
      ],
      ...listOf([
        { key: "t1", threadId: "t1", calls: run.slice(0, 3) },
        { key: "sub1", threadId: "sub1", title: "Fill in the order form", calls: [call(AT - 30_000, [step("read", "Read", "", {}, "Google Chrome")], { app: "Google Chrome", window: "Computer fixture form", read: "Read 78 elements", text: true })] },
      ]),
    }),
    height: 640,
  },
  {
    name: "23. The section in a 260×420 pane: the box at 45% of the section's height",
    props: base({ sessions: [live], viewport: liveBox("textedit", "save-sheet", TEXTEDIT), running: [working("Clicking", "Save")], ...listOf(own(run)) }),
    height: 420,
    widths: [260],
  },
  {
    name: "24a. Loading the steps",
    props: base({ sessions: [live], viewport: liveBox("textedit", "doc", TEXTEDIT), running: [working("Reading", "TextEdit")], status: "loading" }),
  },
  { name: "24b. The read failed: one red line with Retry", props: base({ status: "failed" }), height: 200 },
  {
    name: "24c. More than 200 steps: Show earlier steps",
    props: base({ viewport: kept("textedit", "save-sheet", TEXTEDIT, "2:03 PM"), ...listOf(own(run)), more: true }),
  },
];

export default fixtures;
