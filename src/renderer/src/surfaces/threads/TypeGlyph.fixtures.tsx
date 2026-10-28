// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/TypeGlyph.tsx#TypeGlyph`.
import { THREAD_TYPES } from "./threadTypes";

export default THREAD_TYPES.map((type) => ({ name: type, props: { type, className: "size-3.5" } }));
