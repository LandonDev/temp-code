import { useEffect, useState } from "react";
import type { QuestionMeta } from "../lib/session";
import { answer as answerQuestion } from "../lib/tcserver/commands";
import { cn } from "../lib/cn";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { QuestionCard as Card, type Question } from "../components/ui/question-card";
import { StatusMark } from "../components/ui/status";
import { loadToast } from "../components/ui/toaster";
import { NoticeLine } from "./transcript/NoticeLine";

/** The transcript's card frame, the held review's: full width, the lg radius
 *  and a 12px inset. The type is the card's own. */
export const CARD_SHAPE = "max-w-none rounded-lg p-3";

/** The question's frame: full width, a card that stands alone (12px corners,
 *  16px inset; the card's own). */
export const QUESTION_SHAPE = "max-w-none rounded-xl p-4";

/** A question arriving enters as a transcript row does: it fades in and rises
 *  4px over --dur-base (CSS @starting-style), and only fades under reduced motion. */
export const QUESTION_ENTER =
  "transition-[opacity,translate] duration-(--dur-base) ease-(--ease-out) starting:translate-y-1 starting:opacity-0 motion-reduce:duration-(--dur-fast) motion-reduce:starting:translate-y-0";

/** The free-text option a question offers unless it says otherwise. */
const OTHER = "Other";

/** Questions whose card has entered: a card enters once, never again when the
 *  transcript's window mounts its row a second time. */
const entered = new Set<string>();

/** The harness's questions in the card's shape: the header is a question's
 *  description unless the card's title already says it. */
export function cardQuestions(question: QuestionMeta, title: string): Question[] {
  return question.questions.map((spec) => ({
    prompt: spec.question,
    description: spec.header && spec.header !== title ? spec.header : undefined,
    multiSelect: spec.multiSelect,
    options: [
      ...spec.options.map((option) => ({ label: option.label, description: option.description })),
      ...(spec.allowFreeform !== false ? [{ label: OTHER, freeform: true }] : []),
    ],
  }));
}

/**
 * The model stopped to ask: the set of questions on the one question card
 * (components/ui/question-card.tsx), one at a time, the whole set going
 * back in one answer after the last (an option as its bare label, typed text
 * as typed). Skip dismisses it. Once answered, one line per question says
 * what was picked. The answer lands on the click: the card folds closed on
 * `.collapsible-auto` and the lines open in its place before the host echoes
 * it; an answer the host never took opens the card again, picks kept, and
 * says so in a toast. A set answered before this mount is its lines alone.
 */
export function QuestionCard({
  question,
  onAnswer = (requestId, answers) => answerQuestion(question.sessionId, requestId, answers),
}: {
  question: QuestionMeta;
  onAnswer?: (requestId: string, answers: string[][] | null) => void | Promise<unknown>;
}) {
  const key = `${question.sessionId}:${question.requestId}`;
  const [liveAtMount] = useState(question.answers === undefined);
  const [enter] = useState(() => question.answers === undefined && !entered.has(key));
  const [sent, setSent] = useState<string[][] | null | undefined>(undefined);
  useEffect(() => {
    entered.add(key);
  }, [key]);

  const answers = question.answers !== undefined ? question.answers : sent;
  const done = answers !== undefined;
  if (!liveAtMount) return <AnsweredQuestions question={question} answers={answers ?? null} />;

  const send = (picked: string[][] | null) => {
    if (done) return;
    setSent(picked);
    void Promise.resolve(onAnswer(question.requestId, picked)).catch(() => {
      setSent(undefined);
      void loadToast().then((toast) => toast.error("Couldn't send the answer"));
    });
  };
  const title = question.questions[0]?.header ?? "Questions";
  return (
    <>
      <Collapsible open={!done}>
        {/* Kept while the host has not taken the answer, so a refusal reopens it as it was. */}
        <CollapsibleContent keepMounted={question.answers === undefined} className="collapsible-auto">
          <Card
            className={cn(QUESTION_SHAPE, enter && QUESTION_ENTER)}
            icon={<StatusMark state="waiting" word={false} />}
            title={title}
            questions={cardQuestions(question, title)}
            onSubmitAnswers={send}
            onSkip={() => send(null)}
          />
        </CollapsibleContent>
      </Collapsible>
      <Collapsible open={done}>
        <CollapsibleContent className="collapsible-auto">
          <AnsweredQuestions question={question} answers={answers ?? null} />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** A question's label ends its phrase with ":" (a question keeps its "?"), so the run reads "Approach: Fast, Small", never "Approach, Fast, Small". */
function labelOf(label: string): string {
  return /[?:]$/.test(label) ? label : `${label}:`;
}

function AnsweredQuestions({ question, answers }: { question: QuestionMeta; answers: string[][] | null }) {
  if (answers === null) return <NoticeLine glyph={<StatusMark state="done" word={false} />} lead="Dismissed" />;
  return (
    <>
      {question.questions.map((q, i) => (
        <NoticeLine
          key={i}
          glyph={<StatusMark state="done" word={false} />}
          lead="Answered"
          details={[labelOf(q.header ?? q.question), answers[i]?.join(", ") || "No answer"]}
        />
      ))}
    </>
  );
}
