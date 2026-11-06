import { DUR, EASE_EXIT, EASE_OUT } from "@renderer/lib/ease";
import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";
import { Kbd, KbdGroup } from "./kbd";

/**
 * A question an agent needs answered before it continues: one question at
 * a time, lettered options (A, B, C…) with an optional description line
 * under each, a free-form option that opens a field, Back / Skip / Next,
 * ⌘⏎ to continue. A `multiSelect` question takes several options and one
 * submit. Keys work only while focus is inside the card, so ⌘⏎ in the
 * composer never submits it. With more than one question (`showProgress`)
 * the title row ends with where the person is ("2 of 3"). The caller's status
 * glyph goes in `icon`, flat beside the title. Answers come back as one array
 * of labels per question (the typed text for a free-form pick). The free-form
 * row's field sits beside its toggle, never inside it, so typing never unpicks it.
 */
export type QuestionOption = { label: string; description?: string; freeform?: boolean };
export type Question = { prompt: string; description?: string; options: Array<QuestionOption>; multiSelect?: boolean };

const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Next cross-fades the questions in place: the arriving one over
 *  --dur-base, the leaving one out over --dur-fast, opacity alone. */
const PAGE_MOVE = "flex flex-col transition-opacity motion-reduce:duration-(--dur-fast)";

const PAGE_REST = {
  current: "relative opacity-100 duration-(--dur-base) ease-(--ease-out)",
  away: "absolute inset-x-0 top-0 opacity-0 duration-(--dur-fast) ease-(--ease-exit)",
} as const;

/** The frame reaches past the page by 12px, so a hovered option or a focus ring is never cut. */
const PAGE_INSET = 12;

/** The pages, one shown. The frame's height follows the shown page over
 *  --dur-base: the card is the last thing above the composer, so the glide
 *  moves nothing above it (the transcript's anchor sits above the card). */
function MorphFrame({ at, children }: { at: number; children: Array<ReactNode> }) {
  const [height, setHeight] = useState<number>();
  const pages = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const page = pages.current[at];
    if (!page) return;
    // A page not laid out (a hidden pane, a static render) reads 0: the frame keeps its natural height then.
    const read = () => setHeight(page.offsetHeight || undefined);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(page);
    return () => observer.disconnect();
  }, [at]);
  return (
    <div
      data-slot="question-pages"
      className="-m-3 overflow-hidden p-3 transition-[height] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none"
      style={{ height: height === undefined ? undefined : height + PAGE_INSET * 2 }}
    >
      <div className="relative">
        {children.map((page, index) => (
          <div
            key={index}
            ref={(node) => {
              pages.current[index] = node;
            }}
            data-page={index === at ? "current" : "away"}
            inert={index !== at}
            className={cn(PAGE_MOVE, index === at ? PAGE_REST.current : PAGE_REST.away)}
          >
            {page}
          </div>
        ))}
      </div>
    </div>
  );
}

const LABEL_IN = { duration: DUR.fast, ease: EASE_OUT } as const;
const LABEL_OUT = { duration: DUR.fast, ease: EASE_EXIT } as const;

/** A button's words changing: the width changes at once and the words swap on opacity alone. */
function MorphLabel({ children }: { children: ReactNode }) {
  return (
    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: LABEL_OUT }} transition={LABEL_IN} className="inline-flex whitespace-nowrap">
      {children}
    </motion.span>
  );
}

/** Back arrives at the group's start, so Skip and Next never move. */
const BACK: Variants = {
  hidden: { opacity: 0, transform: "translateX(-8px)", transition: { duration: DUR.fast, ease: EASE_EXIT } },
  shown: { opacity: 1, transform: "translateX(0px)", transition: { duration: DUR.base, ease: EASE_OUT } },
};

/** An option: a flat 36px row (8px above and below the 20px line), its fill
 *  the one selected cue with the key cap; a press steps the fill at once. */
const OPTION = "flex min-h-9 w-full items-start gap-3 rounded-lg px-2 py-2 text-start active:bg-foreground/12";

export function QuestionCard({
  icon,
  title = "Questions",
  questions,
  onSubmitAnswers,
  onSkip,
  showProgress = questions.length > 1,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  questions: Array<Question>;
  onSubmitAnswers?: (answers: Array<Array<string>>) => void;
  onSkip?: () => void;
  /** "2 of 3" at the title row's end; off for a single question. */
  showProgress?: boolean;
  className?: string;
}) {
  const id = useId();
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<number, Array<number>>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});

  const question = questions[at];
  const fields = useRef<Array<HTMLInputElement | null>>([]);
  const lists = useRef<Array<HTMLUListElement | null>>([]);

  const hasAnswer = (index: number) => {
    const choices = picked[index] ?? [];
    if (choices.length === 0) return false;
    const freeform = choices.some((choice) => questions[index]?.options[choice]?.freeform === true);
    return !freeform || choices.length > 1 || (typed[index]?.trim() ?? "") !== "";
  };
  const answered = hasAnswer(at);
  const last = at === questions.length - 1;

  const go = (by: number) => setAt((index) => Math.min(questions.length - 1, Math.max(0, index + by)));

  const back = () => {
    const to = Math.max(0, at - 1);
    go(-1);
    if (to !== 0) return;
    // Back leaves with the first question: focus the pick it holds, not the body.
    window.setTimeout(() => {
      const list = lists.current[0];
      (list?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? list?.querySelector<HTMLElement>("button"))?.focus();
    }, 0);
  };

  const pick = (index: number) => {
    const current = picked[at] ?? [];
    if (current.includes(index)) {
      setPicked((all) => ({ ...all, [at]: current.filter((choice) => choice !== index) }));
      return;
    }
    setPicked((all) => ({ ...all, [at]: question?.multiSelect ? [...current, index].sort((a, b) => a - b) : [index] }));
    if (question?.options[index]?.freeform) window.setTimeout(() => fields.current[at]?.focus(), 0);
  };

  const submit = () => {
    if (!answered) return;
    if (!last) {
      go(1);
      return;
    }
    onSubmitAnswers?.(
      questions.map((entry, index) =>
        (picked[index] ?? []).map((choice) => (entry.options[choice]?.freeform ? (typed[index] ?? "") : (entry.options[choice]?.label ?? ""))),
      ),
    );
  };

  // Keys reach the card only from inside it: a letter picks, ⌘⏎ continues.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!question) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : undefined;
    const index = letter === undefined ? -1 : KEYS.indexOf(letter);
    if (index >= 0 && index < question.options.length) {
      event.preventDefault();
      pick(index);
    }
  };

  if (!question) return null;

  return (
    <div
      data-slot="question-card"
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
      className={cn("w-full max-w-lg rounded-xl border border-border bg-card p-4 font-sans text-card-foreground in-[.bg-card]:border-0 in-[.bg-card]:bg-transparent in-[.bg-card]:p-0", className)}
    >
      <div className="flex min-h-5 items-center gap-2">
        {icon ? <span className="flex shrink-0">{icon}</span> : null}
        <h3 id={`${id}-title`} className="min-w-0 truncate text-sm leading-5 font-medium text-foreground">
          {title}
        </h3>
        {showProgress ? (
          <span data-slot="question-progress" aria-live="polite" className="ms-auto shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
            {at + 1} of {questions.length}
          </span>
        ) : null}
      </div>

      <div className="mt-3">
        <MorphFrame at={at}>
          {questions.map((entry, qIndex) => {
            const choices = picked[qIndex] ?? [];
            return (
              <div key={entry.prompt}>
                <div aria-live="polite">
                  <p className="text-sm leading-[22px] text-foreground">{entry.prompt}</p>
                  {entry.description ? <p className="text-[13px] leading-5 text-muted-foreground">{entry.description}</p> : null}
                </div>
                <ul
                  ref={(node) => {
                    lists.current[qIndex] = node;
                  }}
                  aria-multiselectable={entry.multiSelect || undefined}
                  className="-mx-2 mt-2 flex flex-col gap-1"
                >
                  {entry.options.map((option, index) => {
                    const active = choices.includes(index);
                    const key = KEYS[index];
                    const optionId = `${id}-${qIndex}-${index}`;
                    const fill = active ? "bg-foreground/10" : "hover:bg-foreground/5";
                    // The cap sits on the label's first line: 20px, the line's own height.
                    const cap = (
                      <span
                        aria-hidden
                        data-slot="question-key"
                        className={cn(
                          "pointer-events-none flex size-5 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none font-medium tabular-nums",
                          active ? "bg-primary text-primary-foreground" : "bg-foreground/7 text-muted-foreground",
                        )}
                      >
                        {key}
                      </span>
                    );
                    if (option.freeform) {
                      // The field is no child of the toggle: a button wrapping an input turns the
                      // field's Space and Enter into clicks that unpick the row. The toggle covers
                      // the row; the field rises above it once the row is picked.
                      return (
                        <li key={option.label}>
                          <div data-slot="question-option" className={cn("relative", OPTION, fill)}>
                            <button type="button" aria-pressed={active} aria-label={option.label} onClick={() => pick(index)} className="absolute inset-0 rounded-lg" />
                            {cap}
                            <input
                              ref={(node) => {
                                fields.current[qIndex] = node;
                              }}
                              value={typed[qIndex] ?? ""}
                              readOnly={!active}
                              tabIndex={active ? undefined : -1}
                              aria-label={option.label}
                              placeholder={option.label}
                              onChange={(event) => setTyped((all) => ({ ...all, [qIndex]: event.target.value }))}
                              className={cn(
                                "h-5 w-full bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground",
                                active && "relative",
                              )}
                            />
                          </div>
                        </li>
                      );
                    }
                    return (
                      <li key={option.label}>
                        <button
                          type="button"
                          data-slot="question-option"
                          aria-pressed={active}
                          aria-labelledby={`${optionId}-label`}
                          aria-describedby={option.description ? `${optionId}-description` : undefined}
                          onClick={() => pick(index)}
                          className={cn(OPTION, fill)}
                        >
                          {cap}
                          <span className="flex min-w-0 flex-col">
                            <span id={`${optionId}-label`} className="text-sm leading-5 text-foreground">
                              {option.label}
                            </span>
                            {option.description ? (
                              <span id={`${optionId}-description`} className="text-[13px] leading-5 text-muted-foreground">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </MorphFrame>
      </div>

      <div data-slot="question-actions" className="mt-4 flex items-center justify-end gap-2">
        <MotionConfig reducedMotion="user">
          <AnimatePresence initial={false}>
            {at > 0 ? (
              <motion.span key="back" variants={BACK} initial="hidden" animate="shown" exit="hidden" className="flex">
                <Button variant="secondary" size="sm" onClick={back}>
                  Back
                </Button>
              </motion.span>
            ) : null}
          </AnimatePresence>
        </MotionConfig>
        {onSkip ? (
          <Button variant="secondary" size="sm" onClick={onSkip}>
            Skip
          </Button>
        ) : null}
        <Button size="sm" disabled={!answered} onClick={submit} className="gap-0">
          <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
              <MorphLabel key={last ? "continue" : "next"}>{last ? "Continue" : "Next"}</MorphLabel>
            </AnimatePresence>
          </MotionConfig>
          <KbdGroup className="ms-2">
            <Kbd size="sm" className="justify-center border-transparent bg-background/15 text-current">
              ⌘
            </Kbd>
            <Kbd size="sm" className="justify-center border-transparent bg-background/15 text-current">
              ⏎
            </Kbd>
          </KbdGroup>
        </Button>
      </div>
    </div>
  );
}
