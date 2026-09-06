import { useState } from "react";
import type { QuestionMeta } from "../lib/session";
import { answer as answerQuestion } from "../lib/tcserver/commands";

/**
 * The model stopped to ask. One card per request: each question's
 * options as buttons (toggles when multi-select), a free-text field when
 * the harness allows one, and a single submit for the whole set.
 */
export function QuestionCard({
  question,
  onAnswer = (requestId, answers) =>
    void answerQuestion(question.sessionId, requestId, answers),
}: {
  question: QuestionMeta;
  onAnswer?: (requestId: string, answers: string[][] | null) => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() =>
    question.questions.map(() => []),
  );
  const [other, setOther] = useState<string[]>(() =>
    question.questions.map(() => ""),
  );

  if (question.answers !== undefined) {
    return (
      <div className="mt-1 flex flex-col gap-1 text-[12px] text-content/60">
        {question.answers === null ? (
          <span>Dismissed</span>
        ) : (
          question.questions.map((q, i) => (
            <div key={i} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 text-content/45">{q.header ?? q.question}</span>
              <span className="min-w-0 truncate text-content/80">
                {question.answers?.[i]?.join(", ") || "No answer"}
              </span>
            </div>
          ))
        )}
      </div>
    );
  }

  const answers = question.questions.map((_, i) => {
    const typed = other[i].trim();
    return typed ? [...picked[i], typed] : picked[i];
  });
  const complete = answers.every((a) => a.length > 0);

  const toggle = (i: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const next = prev.slice();
      const has = next[i].includes(label);
      next[i] = multi
        ? has
          ? next[i].filter((l) => l !== label)
          : [...next[i], label]
        : has
          ? []
          : [label];
      return next;
    });
  };

  return (
    <div className="mt-1.5 flex flex-col gap-3">
      {question.questions.map((q, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="text-[13px] leading-5 text-content/85">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((option) => {
              const on = picked[i].includes(option.label);
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
                  onClick={() => toggle(i, option.label, q.multiSelect === true)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {q.allowFreeform !== false ? (
            <input
              type="text"
              value={other[i]}
              placeholder="Other"
              className="w-full max-w-sm rounded-md border border-content/12 bg-transparent px-2 py-1 text-[12px] text-content/85 outline-none placeholder:text-content/35 focus:border-content/30"
              onChange={(e) =>
                setOther((prev) => {
                  const next = prev.slice();
                  next[i] = e.target.value;
                  return next;
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && complete) onAnswer?.(question.requestId, answers);
              }}
            />
          ) : null}
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!complete}
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/80 disabled:opacity-40"
          onClick={() => onAnswer?.(question.requestId, answers)}
        >
          Submit
        </button>
        <button
          type="button"
          className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
          onClick={() => onAnswer?.(question.requestId, null)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
