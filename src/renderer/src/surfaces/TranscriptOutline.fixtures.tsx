// Fixtures for `bun run ui:preview src/renderer/src/surfaces/TranscriptOutline.tsx#TranscriptOutline`:
// the message list at its 208px width, one day and several, the entry being
// read mid-list, a long line, a mention (no store here, so it reads "a
// thread"), a message that is only an attachment, and Earlier messages.
import type { Block } from "../lib/session";

const NOW = new Date(2026, 10, 1, 18, 0).getTime();
/** A day of Oct 30 to Nov 1, 2026 (months count from 0). */
const at = (d: number, h: number, m: number) => new Date(2026, d >= 30 ? 9 : 10, d, h, m).getTime();

const user = (id: string, text: string, startedAt: number, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text,
  startedAt,
  ...extra,
});
const reply = (id: string): Block => ({ id, role: "assistant", text: "Done." });
const turn = (u: Block): Block[] => [u, reply(`${u.id}-r`)];

const oneDay: Block[][] = [
  turn(user("u1", "Why does the rail flicker when a thread settles?", at(1, 9, 4))),
  turn(user("u2", "Try it with the panel closed", at(1, 9, 31))),
  turn(user("u3", "## Next\nMake the left side a list of my messages", at(1, 14, 32))),
  turn(user("u4", "Ship it", at(1, 16, 8))),
];

const threeDays: Block[][] = [
  turn(user("d1", "Plan the stability pass for the box and the Mac, starting with the launch mirror and the gateway", at(30, 22, 15))),
  turn(user("d2", "See @thread:abcdef1 before you start", at(30, 22, 40))),
  turn(user("d3", "", at(31, 10, 2), { attachments: [{ id: "a", name: "rail-flicker.png", mimeType: "image/png", kind: "image", size: 1 }] })),
  turn(user("d4", "> the gate failed on vitest\nWhy?", at(31, 11, 20))),
  turn(user("d5", "Good, land it", at(1, 8, 45))),
];

const props = { onJump: "fn", now: NOW, locale: "en-US", className: "w-52" };

export default [
  { name: "One day: no labels, the third message being read", props: { ...props, turns: oneDay, readerTurn: 2 } },
  { name: "Three days: day labels, a long line, a mention, an attachment", props: { ...props, turns: threeDays, readerTurn: 3 } },
  { name: "A 24-hour clock", props: { ...props, turns: oneDay, readerTurn: 0, locale: "en-GB" } },
  {
    name: "Older history left: Earlier messages",
    props: { ...props, turns: oneDay, readerTurn: 0, hasOlder: true, onLoadEarlier: "fn" },
  },
];
