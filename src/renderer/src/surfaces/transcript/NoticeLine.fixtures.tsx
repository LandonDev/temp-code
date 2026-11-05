// The one notice line's shapes for `bun run ui:preview src/renderer/src/surfaces/transcript/NoticeLine.tsx#NoticeLine`.
// A line that folds needs its Collapsible: GateCard.fixtures.tsx and ReviewCard.fixtures.tsx show those.
import { FoldVertical, GitMerge } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";

export const fixtures = [
  { name: "A plain system line, wrapping", props: { lead: "The host restarted during your turn at 2:04 PM; continue where you left off.", wrap: true } },
  { name: "A lead and its details", props: { glyph: <FoldVertical className="size-3.5" />, lead: "Context compacted", details: ["148k → 22k", "6s"] } },
  {
    name: "Strong: a red run's lead in foreground",
    props: { glyph: <StatusMark state="failed" word={false} />, lead: "Batch stopped", tone: "strong", details: ["gate failed at vitest"] },
  },
  {
    name: "A trailing status after the details",
    props: { glyph: <GitMerge className="size-3.5" />, lead: "Merged", details: ["port-the-view", "into master"], trailing: <StatusMark state="done" detail="pushed" /> },
  },
  {
    name: "Actions on hover (hidden at rest)",
    props: {
      glyph: <StatusMark state="done" word={false} />,
      lead: "Pass",
      details: ["3 tasks checked"],
      actions: (
        <Button variant="ghost" size="xs" className="-my-0.5 text-muted-foreground">
          Run again
        </Button>
      ),
    },
  },
  {
    name: "A long detail truncates; the lead never does",
    props: { glyph: <StatusMark state="done" word={false} />, lead: "Reviewed by GPT-6.1 Sol", details: ["no blocking findings", "a detail long enough to run past the edge of a narrow column and truncate there"] },
  },
];
