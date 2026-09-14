import { useState, type ReactNode } from "react";
import type { QuestionMeta, QuestionSpec } from "../lib/session";
import { answer as answerQuestion } from "../lib/tcserver/commands";
import {
  advance,
  advanceLabel,
  answersOf,
  back,
  initialStepper,
  pickAndAdvance,
  stepComplete,
  stepLabel,
  typeOther,
  type StepperState,
} from "../lib/questionStepper";
import { ChevronLeft } from "../chrome/icons";
import { slideQuestionPage } from "./threads/questionPage";

/**
 * The model stopped to ask. One question shows at a time however many the
 * harness batched: a single-select pick answers it and moves on, a
 * multi-select or typed answer waits for Next, and the whole set goes back
 * in one answer after the last. Back keeps every pick.
 *
 * `renderPage` is the seam for the page motion: it receives each step's
 * body with the step index as its key. The default is the keyed slide
 * from `threads/questionPage`; pass the identity to render pages still.
 */
export function QuestionCard({
  question,
  onAnswer = (requestId, answers) =>
    void answerQuestion(question.sessionId, requestId, answers),
  renderPage = slideQuestionPage,
}: {
  question: QuestionMeta;
  onAnswer?: (requestId: string, answers: string[][] | null) => void;
  renderPage?: (page: ReactNode, step: number) => ReactNode;
}) {
  const questions = question.questions;
  const count = questions.length;
  const [state, setState] = useState<StepperState>(() => initialStepper(count));

  if (question.answers !== undefined) {
    return <AnsweredQuestions question={question} />;
  }

  const submit = (s: StepperState) => onAnswer?.(question.requestId, answersOf(s));
  const q = questions[state.step];
  if (!q) return null;
  const counter = stepLabel(state.step, count);
  const complete = stepComplete(state, state.step);

  const pick = (label: string) => {
    const r = pickAndAdvance(state, questions, label);
    setState(r.state);
    if (r.done) submit(r.state);
  };
  const go = () => {
    const r = advance(state, count);
    setState(r.state);
    if (r.done) submit(r.state);
  };

  return (
    <div className="mt-1.5 flex flex-col gap-3">
      {renderPage(
        <QuestionPage
          key={state.step}
          spec={q}
          picked={state.picked[state.step]}
          other={state.other[state.step]}
          onPick={pick}
          onType={(text) => setState((s) => typeOther(s, s.step, text))}
          onEnter={go}
        />,
        state.step,
      )}
      <div className="flex items-center gap-2">
        {state.step > 0 ? (
          <button
            type="button"
            aria-label="Previous question"
            className="grid size-6 place-items-center rounded-md bg-content/10 text-content/70 hover:bg-content/20"
            onClick={() => setState(back(state))}
          >
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
        <button
          type="button"
          disabled={!complete}
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/70 disabled:opacity-40"
          onClick={go}
        >
          {advanceLabel(state, count)}
        </button>
        <button
          type="button"
          className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
          onClick={() => onAnswer?.(question.requestId, null)}
        >
          Dismiss
        </button>
        {counter ? (
          <span className="ml-auto text-[11px] tabular-nums text-content/40">{counter}</span>
        ) : null}
      </div>
    </div>
  );
}

/** One question: its prompt, its options and the free-text field. */
export function QuestionPage({
  spec,
  picked,
  other,
  onPick,
  onType,
  onEnter,
}: {
  spec: QuestionSpec;
  picked: string[];
  other: string;
  onPick: (label: string) => void;
  onType: (text: string) => void;
  onEnter: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {spec.header ? (
        <div className="text-[11px] uppercase tracking-wide text-content/40">{spec.header}</div>
      ) : null}
      <div className="text-[13px] leading-5 text-content">{spec.question}</div>
      <div className="flex flex-wrap gap-1.5">
        {spec.options.map((option) => {
          const on = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
              title={option.description}
              className={
                on
                  ? "rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base"
                  : "rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
              }
              onClick={() => onPick(option.label)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {spec.allowFreeform !== false ? (
        <input
          type="text"
          value={other}
          placeholder="Other"
          className="w-full max-w-sm rounded-md border border-content/12 bg-transparent px-2 py-1 text-[12px] text-content outline-none placeholder:text-content/40 focus:border-content/30"
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
          }}
        />
      ) : null}
    </div>
  );
}

function AnsweredQuestions({ question }: { question: QuestionMeta }) {
  return (
    <div className="mt-1 flex flex-col gap-1 text-[12px] text-content/50">
      {question.answers === null ? (
        <span>Dismissed</span>
      ) : (
        question.questions.map((q, i) => (
          <div key={i} className="flex min-w-0 gap-1.5">
            <span className="shrink-0 text-content/40">{q.header ?? q.question}</span>
            <span className="min-w-0 truncate text-content/70">
              {question.answers?.[i]?.join(", ") || "No answer"}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
