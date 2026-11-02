// Fixtures for `bun run ui:preview src/renderer/src/motion/IconSwap.tsx#SwapIcon`.
import { Check, Copy, FileText } from "../chrome/icons";
import { StatusMark } from "../components/ui/status";

const faces = { from: <Copy className="size-3.5" />, to: <Check className="size-3.5" /> };

export default [
  { name: "at rest: Copy", props: { ...faces, swapped: false } },
  { name: "swapped: Check", props: { ...faces, swapped: true } },
  { name: "keyed: working", props: { state: "working", children: <StatusMark state="working" word={false} /> } },
  { name: "keyed: icon", props: { state: "icon", children: <FileText className="size-3.5" /> } },
];
