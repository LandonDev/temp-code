/**
 * The file and symbol pickers (Go to File, Go to Symbol), one barrel behind
 * `pickersChunk` (surfaces/chunks.ts): App mounts each only while it is open,
 * and the first thread on screen warms the chunk in an idle slot.
 */
export { FilePicker } from "./FilePicker";
export { SymbolPicker } from "./SymbolPicker";
