// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/ComputerPreview.tsx#PreviewBox`.
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import type { PreviewState } from "../../lib/computerPreview";
import { ClickMark, PreviewLine, pictureClass } from "./ComputerPreview";

/** The recorded TextEdit window (fixtures/apps/textedit/doc), loaded from disk by the preview page. */
const still = new URL("../../../../main/server/computer/fixtures/apps/textedit/doc/window.jpg", import.meta.url).href;
const size = { width: 1206, height: 1010 };
const live: PreviewState = { status: "live", app: "TextEdit", window: "Untitled", ...size, frames: 12 };
const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "s1",
  since: 0,
  lastCallAt: 0,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "ax",
  ...over,
});
const frame = <img src={still} alt="" className={pictureClass(true)} />;
const base = { label: "Preview of Untitled in TextEdit", size, drawn: true, picture: frame };
/** An ended preview is its line alone: nothing more will come into the box. */
const ended = (reason: Extract<PreviewState, { status: "ended" }>["reason"]) => ({
  name: `ended: ${reason}`,
  props: { ...base, box: false, line: <PreviewLine row={row()} state={{ status: "ended", reason }} onRetry={() => {}} /> },
});

export default [
  { name: "a frame with the agent's click mid-play", props: { ...base, mark: <ClickMark at={[0.31, 0.42]} frozen /> } },
  { name: "starting: the skeleton in the stream's shape", props: { ...base, size: null, drawn: false, picture: <canvas className={pictureClass(false)} /> } },
  { name: "a tall window narrows inside the box", props: { ...base, size: { width: 930, height: 1280 }, picture: <img src={new URL("../../../../main/server/computer/fixtures/apps/chrome/form/window.jpg", import.meta.url).href} alt="" className={pictureClass(true)} /> } },
  {
    name: "a held step under the frame",
    props: { ...base, line: <PreviewLine row={row({ running: { tool: "computer_act", words: "Waiting for the Mac to be free, 2nd in line", startedAt: 0, held: true } })} state={live} /> },
  },
  { name: "a card waiting on the Mac", props: { ...base, line: <PreviewLine row={row({ asking: { line: "Click Save in TextEdit?" } })} state={live} /> } },
  ended("window-closed"),
  ended("minimized"),
  ended("permission"),
  ended("error"),
];
