import type { QuestionMeta } from "../lib/session";
import { answer as answerQuestion } from "../lib/tcserver/commands";
import { QuestionCard as Card, type Question } from "../components/ui/question-card";
import { StatusMark } from "../components/ui/status";
import { NoticeLine } from "./transcript/NoticeLine";

/** The free-text option a question offers unless it says otherwise. */
const OTHER = "Other";

/** The harness's questions in the card's shape: the header is a question's
 *  description unless the card's title already says it. */
export function cardQuestions(question: QuestionMeta, title: string): Question[] {
  return question.questions.map((spec) => ({
    prompt: spec.question,
    description: spec.header && spec.header !== title ? spec.header : undefined,
    multiSelect: spec.multiSelect,
    options: [
      ...spec.options.map((option) => ({ label: option.label })),
      ...(spec.allowFreeform !== false ? [{ label: OTHER, freeform: true }] : []),
    ],
  }));
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
      className="my-2"
      title={title}
      questions={cardQuestions(question, title)}
      onSubmitAnswers={(answers) => onAnswer(question.requestId, answers)}
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
