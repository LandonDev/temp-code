// Fixtures for `bun run ui:preview src/renderer/src/chrome/ComputerCue.preview.tsx#ComputerCueEndGroup`:
// the title bar's end group at each state of the computer cue.
import type { ComputerCue } from "../lib/computerSection";

const using: ComputerCue = { state: "working", label: "Using TextEdit", line: "Computer use: Clicking Save in TextEdit" };
const needs: ComputerCue = { state: "waiting", label: "Needs you", line: "Computer use: Click Save in TextEdit?" };
const held: ComputerCue = { state: "queued", label: "Waiting for the Mac", line: "Computer use: Waiting for the Mac to be free, 2nd in line" };

export default [
  { name: "No live session: ⋯ and Panel alone", props: { cue: null } },
  { name: "Using TextEdit: the still dot, since the thread's own turn spins", props: { cue: using } },
  { name: "A card waits: Needs you in amber", props: { cue: needs } },
  { name: "A step held in line: Waiting for the Mac", props: { cue: held } },
  { name: "Pressed: the panel is open on Computer", props: { cue: using, pressed: true } },
  { name: "No room for the panel", props: { cue: using, room: false } },
];
