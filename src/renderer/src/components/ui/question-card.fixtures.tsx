// Fixtures for `bun run ui:preview src/renderer/src/components/ui/question-card.tsx#QuestionCard`:
// the card as the transcript mounts it (surfaces/QuestionCard.tsx's frame and
// glyph). A static render shows each set's first question with nothing picked;
// picks, pages and the free-form field's typing are DOM-tested.
import { StatusMark } from "./status";
import type { Question } from "./question-card";

const frame = { className: "my-2 max-w-none rounded-lg p-3", icon: <StatusMark state="waiting" word={false} />, onSkip: "fn", onSubmitAnswers: "fn" };

const described: Question[] = [
  {
    prompt: "How should the importer treat rows it cannot parse?",
    options: [
      { label: "Skip them", description: "Log each row's line number and keep going" },
      { label: "Stop the import", description: "Nothing is written until the file is clean" },
      { label: "Import them as drafts", description: "They show in the review list with the parse error" },
      { label: "Other", freeform: true },
    ],
  },
];

const three: Question[] = [
  { prompt: "Which branch should the release cut from?", description: "Branch", options: [{ label: "master" }, { label: "stable" }, { label: "Other", freeform: true }] },
  { prompt: "Run the iOS tests too?", options: [{ label: "Yes" }, { label: "No" }] },
  { prompt: "Notify the box when it is live?", options: [{ label: "Yes" }, { label: "No" }] },
];

const multi: Question[] = [
  {
    prompt: "Which checks should block the merge?",
    multiSelect: true,
    options: [{ label: "Typecheck" }, { label: "Unit tests", description: "vitest, the touched files only" }, { label: "Bundle size" }, { label: "Lint" }],
  },
];

const freeform: Question[] = [{ prompt: "What should the new command be called?", options: [{ label: "sync" }, { label: "Other", freeform: true }] }];

export default [
  { name: "One question with descriptions", props: { ...frame, title: "Parse errors", questions: described } },
  { name: "Three questions", props: { ...frame, title: "Release", questions: three } },
  { name: "Multi-select", props: { ...frame, title: "Merge checks", questions: multi } },
  { name: "A free-form option", props: { ...frame, title: "Naming", questions: freeform } },
];
