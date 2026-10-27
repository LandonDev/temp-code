// Fixtures for `bun run ui:preview src/renderer/src/motion/IconSwap.tsx#SwapIcon`.
import { Check, Copy } from "../chrome/icons";

const faces = { from: <Copy className="size-3.5" strokeWidth={1.75} />, to: <Check className="size-3.5" strokeWidth={1.75} /> };

export default [
  { name: "at rest: Copy", props: { ...faces, swapped: false } },
  { name: "swapped: Check", props: { ...faces, swapped: true } },
];
