import type { QuestionMeta } from "../lib/session";
import { answer as answerQuestion } from "../lib/tcserver/commands";
import { QuestionCard as Card, type Question } from "../components/ui/question-card";
import { StatusMark } from "../components/ui/status";
import { NoticeLine } from "./transcript/NoticeLine";
import { cn } from "../lib/cn";

/** The transcript's one card shape (the failure card's): full width, the lg
 *  radius, a 12px inset and a 13px medium title. */
const CARD_SHAPE = "my-2 max-w-none rounded-lg p-3 [&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:tracking-normal";
/** One question has no progress to show: the header's ring and its count go. */
const NO_PROGRESS = "[&>div:first-child>span:last-child]:hidden";

/** The free-text option a question offers unless it says otherwise. */
const OTHER = "Other";

/** What an option reads on the card: its label, and its description when it
 *  has one (the card has no line of its own for it). */
const shownLabel = (option: { label: string; description?: string }) =>
  option.description ? `${option.label}: ${option.description}` : option.label;

/** The harness's questions in the card's shape: the header is a question's
 *  description unless the card's title already says it. */
export function cardQuestions(question: QuestionMeta, title: string): Question[] {
  return question.questions.map((spec) => ({
    prompt: spec.question,
    description: spec.header && spec.header !== title ? spec.header : undefined,
    multiSelect: spec.multiSelect,
    options: [
      ...spec.options.map((option) => ({ label: shownLabel(option) })),
      ...(spec.allowFreeform !== false ? [{ label: OTHER, freeform: true }] : []),
    ],
  }));
}

/** The card's answers in the harness's words: a picked option goes back as
 *  its bare label; typed text goes back as typed. */
export function harnessAnswers(question: QuestionMeta, answers: string[][]): string[][] {
  return answers.map((picked, i) => {
    const options = question.questions[i]?.options ?? [];
    return picked.map((shown) => options.find((option) => shownLabel(option) === shown)?.label ?? shown);
  });
}

/**
 * The model stopped to ask: the set of questions on the one question card
 * (components/ui/question-card.tsx), one at a time, the whole set going
 * back in one answer after the last. Skip dismisses it. Once answered, one
 * line per question says what was picked.
 */
export function QuestionCard({
  question,
  onAnswer = (requestId, answers) => void answerQuestion(question.sessionId, requestId, answers),
}: {
  question: QuestionMeta;
  onAnswer?: (requestId: string, answers: string[][] | null) => void;
}) {
  if (question.answers !== undefined) return <AnsweredQuestions question={question} />;
  const title = question.questions[0]?.header ?? "Questions";
  return (
    <Card
      className={cn(CARD_SHAPE, question.questions.length === 1 && NO_PROGRESS)}
      title={title}
      questions={cardQuestions(question, title)}
      onSubmitAnswers={(answers) => onAnswer(question.requestId, harnessAnswers(question, answers))}
      onSkip={() => onAnswer(question.requestId, null)}
    />
  );
}

function AnsweredQuestions({ question }: { question: QuestionMeta }) {
  if (question.answers === null) return <NoticeLine glyph={<StatusMark state="done" word={false} />} lead="Dismissed" />;
  return (
    <>
      {question.questions.map((q, i) => (
        <NoticeLine
          key={i}
          glyph={<StatusMark state="done" word={false} />}
          lead="Answered"
          details={[q.header ?? q.question, question.answers?.[i]?.join(", ") || "No answer"]}
        />
      ))}
    </>
  );
}
