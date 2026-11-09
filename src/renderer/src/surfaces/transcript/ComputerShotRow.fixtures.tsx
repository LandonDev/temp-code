// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/ComputerShotRow.tsx#ComputerShotRow`.
import { formatShotLine, formatStepLine } from "@shared/computer/tools";
import type { Block } from "../../lib/session";
import type { ShotMedia } from "./ComputerShotRow";

const file = (app: string): string => new URL(`../../../../main/server/computer/fixtures/apps/${app}/window.jpg`, import.meta.url).href;
const shots = [
  { path: "/w/.temp-code/attachments/s1/computer/0001.jpg", width: 1206, height: 1010, url: file("textedit/doc") },
  { path: "/w/.temp-code/attachments/s1/computer/0002.jpg", width: 1206, height: 1010, url: file("textedit/save-sheet") },
  { path: "/w/.temp-code/attachments/s1/computer/0003.jpg", width: 930, height: 1280, url: file("chrome/form") },
  { path: "/w/.temp-code/attachments/s1/computer/0004.jpg", width: 1206, height: 1010, url: file("textedit/typed") },
];
const header = 'app "TextEdit" · window "Untitled" · 1206×1010 · changes since your last read';
const screenshot = formatStepLine({ index: 0, action: "screenshot", status: "ok", tier: null, effect: "unknown" }, { action: "screenshot" });

function block(n: number): Block {
  const picked = shots.slice(0, n);
  const detail = [...picked.map(() => screenshot), ...picked.map((s, i) => formatShotLine(i + 1, i + 1, s, true)), "", header].join("\n");
  return {
    id: `b${n}`,
    role: "tool",
    text: "computer",
    tool: {
      callId: `c${n}`,
      name: n === 1 ? "mcp__app__computer_act" : "mcp__app__computer_batch",
      status: "completed",
      input: n === 1 ? { app: "TextEdit", action: "screenshot" } : { app: "TextEdit", actions: picked.map(() => ({ action: "screenshot" })) },
      detail,
    },
  };
}
const ready = (n: number): Record<string, ShotMedia> => Object.fromEntries(shots.slice(0, n).map((s) => [s.path, { status: "ready", url: s.url }]));

export default [
  { name: "one picture", props: { block: block(1), host: "local", media: ready(1) } },
  { name: "two pictures", props: { block: block(2), host: "local", media: ready(2) } },
  { name: "four pictures", props: { block: block(4), host: "local", media: ready(4) } },
  { name: "loading", props: { block: block(1), host: "local", media: { [shots[0].path]: { status: "pending" } } } },
  { name: "a file the host no longer has", props: { block: block(1), host: "local", media: { [shots[0].path]: { status: "missing" } } } },
];
