import { RefreshCw } from "@renderer/chrome/icons";
import { AnimatePresence, motion, MotionConfig, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";
import { Kbd, KbdGroup } from "./kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A question an agent needs answered before it continues: one question at
 * a time, lettered options (A, B, C…), a free-form option that opens a
 * field, Previous / Skip / Next, ⌘⏎ to continue. A `multiSelect` question
 * takes several options and one submit. Keys work only while focus is
 * inside the card, so ⌘⏎ in the composer never submits it. The reset
 * glyph swaps with a donut of how many are answered. Answers come back as
 * one array of labels per question (the typed text for a free-form pick).
 */
export type QuestionOption = { label: string; freeform?: boolean };
export type Question = { prompt: string; description?: string; options: Array<QuestionOption>; multiSelect?: boolean };

const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const PAGE_MOVE = "flex flex-col transition-[opacity,translate,filter] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none";

const PAGE_REST = {
  current: "relative translate-y-0 opacity-100 blur-[0px]",
  before: "absolute inset-x-0 top-0 -translate-y-3 opacity-0 blur-[3px]",
  after: "absolute inset-x-0 top-0 translate-y-3 opacity-0 blur-[3px]",
} as const;

const PAGE_INSET = 16;

function MorphFrame({ at, children }: { at: number; children: Array<ReactNode> }) {
  const [height, setHeight] = useState<number>();
  const pages = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const page = pages.current[at];
    if (!page) return;
    setHeight(page.offsetHeight);
    const observer = new ResizeObserver(() => setHeight(page.offsetHeight));
    observer.observe(page);
    return () => observer.disconnect();
  }, [at]);
  return (
    <div className="-m-4 overflow-hidden p-4 transition-[height] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none" style={{ height: height === undefined ? undefined : height + PAGE_INSET * 2 }}>
      <div className="relative">
        {children.map((page, index) => (
          <div
            key={index}
            ref={(node) => {
              pages.current[index] = node;
            }}
            inert={index !== at}
            className={cn(PAGE_MOVE, index === at ? PAGE_REST.current : index < at ? PAGE_REST.before : PAGE_REST.after)}
          >
            {page}
          </div>
        ))}
      </div>
    </div>
  );
}

const LABEL_MORPH = { type: "spring", duration: 0.3, bounce: 0 } as const;
const LABEL_OUT = { type: "spring", duration: 0.2, bounce: 0 } as const;

function MorphLabel({ children }: { children: ReactNode }) {
  return (
    <motion.span initial={{ width: 0 }} animate={{ width: "auto" }} exit={{ width: 0 }} transition={LABEL_MORPH} className="inline-flex min-w-0 items-center overflow-hidden">
      <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6, transition: LABEL_OUT }} transition={LABEL_MORPH} className="inline-flex whitespace-nowrap">
        {children}
      </motion.span>
    </motion.span>
  );
}

const DONUT_W = 1.75;
const DONUT_R = 8 - DONUT_W / 2;
const DONUT_C = 2 * Math.PI * DONUT_R;

function ProgressDonut({ done, total }: { done: number; total: number }) {
  const filled = total > 0 ? done / total : 0;
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 shrink-0">
      <circle cx="8" cy="8" r={DONUT_R} strokeWidth={DONUT_W} className="stroke-muted-foreground/45" />
      <circle
        cx="8"
        cy="8"
        r={DONUT_R}
        strokeWidth={DONUT_W}
        strokeLinecap={filled > 0 ? "round" : "butt"}
        strokeDasharray={DONUT_C}
        strokeDashoffset={DONUT_C * (1 - filled)}
        transform="rotate(-90 8 8)"
        className="stroke-foreground transition-[stroke-dashoffset] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none"
      />
    </svg>
  );
}

const TURN = { type: "spring", duration: 0.55, bounce: 0.18 } as const;
const MARK_SWAP = "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none";

const PREVIOUS: Variants = {
  hidden: { opacity: 0, x: -8, filter: "blur(2px)", transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } },
  shown: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } },
};

export function QuestionCard({
  icon,
  title = "Questions",
  questions,
  onSubmitAnswers,
  onSkip,
  onReset,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  questions: Array<Question>;
  onSubmitAnswers?: (answers: Array<Array<string>>) => void;
  onSkip?: () => void;
  onReset?: () => void;
  className?: string;
}) {
  const [at, setAt] = useState(0);
  const [turns, setTurns] = useState(0);
  const [turning, setTurning] = useState(false);
  const still = useReducedMotion() ?? false;
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
  const answeredCount = questions.filter((_, index) => hasAnswer(index)).length;

  const go = (by: number) => setAt((index) => Math.min(questions.length - 1, Math.max(0, index + by)));

  const back = () => {
    const to = Math.max(0, at - 1);
    go(-1);
    if (to !== 0) return;
    window.setTimeout(() => {
      const list = lists.current[0];
      (list?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? list?.querySelector<HTMLElement>("button"))?.focus();
    }, 0);
  };

  const reset = () => {
    setAt(0);
    setPicked({});
    setTyped({});
    setTurns((turn) => turn + 1);
    setTurning(true);
    onReset?.();
  };
  useEffect(() => {
    if (!turning) return;
    const done = window.setTimeout(() => setTurning(false), TURN.duration * 1000);
    return () => window.clearTimeout(done);
  }, [turning, turns]);

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
    if (at < questions.length - 1) {
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
    <div data-slot="question-card" onKeyDown={onKeyDown} className={cn("w-full max-w-lg rounded-xl border border-border bg-card p-4 text-card-foreground", className)}>
      <div className="flex items-center gap-2.5">
        {icon ? <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <span className="ms-auto flex items-center">
          <span className="sr-only" aria-live="polite">
            {answeredCount} of {questions.length} answered
          </span>
          <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Reset the answers"
                data-turning={turning || undefined}
                onClick={reset}
                className="group/reset relative grid size-4 shrink-0 place-items-center rounded-full outline-none transition-[scale] duration-(--dur-base) ease-(--ease-out) after:absolute after:-inset-3 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
              />
            }
          >
            <span className={cn(MARK_SWAP, "grid group-hover/reset:scale-90 group-hover/reset:opacity-0 group-hover/reset:blur-[2px] group-focus-visible/reset:scale-90 group-focus-visible/reset:opacity-0 group-data-turning/reset:scale-90 group-data-turning/reset:opacity-0")}>
              <ProgressDonut done={answeredCount} total={questions.length} />
            </span>
            <span aria-hidden className={cn(MARK_SWAP, "grid size-4 scale-90 place-items-center text-foreground opacity-0 blur-[2px] group-hover/reset:scale-100 group-hover/reset:opacity-100 group-hover/reset:blur-none group-focus-visible/reset:scale-100 group-focus-visible/reset:opacity-100 group-data-turning/reset:scale-100 group-data-turning/reset:opacity-100 group-data-turning/reset:blur-none")}>
              <motion.span animate={{ rotate: turns * 360 }} transition={still ? { duration: 0 } : TURN} className="flex">
                <RefreshCw className="size-4" />
              </motion.span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Reset</TooltipContent>
          </Tooltip>
        </span>
      </div>

      <div className="mt-3">
        <MorphFrame at={at}>
          {questions.map((entry, qIndex) => {
            const choices = picked[qIndex] ?? [];
            return (
              <div key={entry.prompt}>
                <div aria-live="polite">
                  <p className="text-sm">{entry.prompt}</p>
                  {entry.description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{entry.description}</p> : null}
                </div>
                <ul
                  ref={(node) => {
                    lists.current[qIndex] = node;
                  }}
                  aria-multiselectable={entry.multiSelect || undefined}
                  className="-mx-2.5 mt-2.5 space-y-1"
                >
                  {entry.options.map((option, index) => {
                    const active = choices.includes(index);
                    const key = KEYS[index];
                    return (
                      <li key={option.label}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={(event) => {
                            if (active && event.target instanceof HTMLInputElement) return;
                            pick(index);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-start outline-none transition-[background-color,border-color] duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                            active ? "border-border bg-foreground/5" : "border-transparent hover:bg-foreground/5",
                          )}
                        >
                          <span aria-hidden className={cn("pointer-events-none flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium tabular-nums", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                            {key}
                          </span>
                          {option.freeform ? (
                            <input
                              ref={(node) => {
                                fields.current[qIndex] = node;
                              }}
                              value={typed[qIndex] ?? ""}
                              readOnly={!active}
                              placeholder={option.label}
                              onChange={(event) => setTyped((all) => ({ ...all, [qIndex]: event.target.value }))}
                              className="w-full cursor-[inherit] bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                            />
                          ) : (
                            <span className="text-[13px]">{option.label}</span>
                          )}
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <MotionConfig reducedMotion="user">
          <AnimatePresence initial={false}>
            {at > 0 ? (
              <motion.span key="previous" variants={PREVIOUS} initial="hidden" animate="shown" exit="hidden" className="flex">
                <Button variant="secondary" size="sm" onClick={back}>
                  Previous
                </Button>
              </motion.span>
            ) : null}
          </AnimatePresence>
        </MotionConfig>
        <span className="ms-auto flex items-center gap-2">
          {onSkip ? (
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          ) : null}
          <Button size="sm" disabled={!answered} onClick={submit} className="gap-0">
            <MotionConfig reducedMotion="user">
              <AnimatePresence initial={false}>
                <MorphLabel key={at < questions.length - 1 ? "next" : "continue"}>{at < questions.length - 1 ? "Next" : "Continue"}</MorphLabel>
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
        </span>
      </div>
    </div>
  );
}
