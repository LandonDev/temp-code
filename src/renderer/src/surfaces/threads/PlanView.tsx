import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ThreadRules } from "@server/shared/rules";
import { AccessPicker } from "../../chrome/AccessPicker";
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitFork,
  ListChecks,
  Play,
  SlidersHorizontal,
  X,
} from "../../chrome/icons";
import { ModelPicker } from "../../chrome/ModelPicker";
import { ModelSettings } from "../../chrome/ModelSettings";
import { ThreadTune, normalizeTune, tuneSummary } from "../../chrome/ThreadTune";
import { Popover } from "../../chrome/Popover";
import {
  mergeModelSettings,
  nativeModelId,
  resolveModel,
} from "../../lib/models";
import {
  sessionDisplayTitle,
  type HarnessId,
  type RuntimeMode,
  type Session,
} from "../../lib/session";
import { policyForMode } from "../../lib/tcserver/access";
import { startThread } from "../../lib/tcserver/commands";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta, ThreadType } from "../../lib/tcserver/types";
import {
  planTasks,
  splitSections,
  type Section,
} from "../../lib/threads/planDoc";
import { usePlanFile } from "../../hooks/usePlanFile";
import { AgentMarkdown } from "../AgentMarkdown";
import {
  MatrixSpinner,
  PaneHeader,
  THREAD_GLYPHS,
  THREAD_LABELS,
  THREAD_TINTS,
  timeAgo,
} from "./bits";
import { FleetPulseLine } from "./fleet/FleetPanel";
import { FleetSlot } from "./FleetSlot";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Planning thread, in three phases. It opens as a normal chat — the
 * conversation is the whole surface while the plan is being shaped. The
 * moment the plan document has content, the document grows in on the
 * left and the chat continues alongside on the right — an even split, with
 * a draggable divider (double-click resets). Once the plan has handed off,
 * the chat collapses to a slim bar on the right edge; one click brings it
 * back. A thread stopped on a question always forces the chat open.
 * Starting the build lives in the plan pane's header — the plan is what
 * you approve, so that is where its action sits.
 */

const subscribeMetas = (cb: () => void): (() => void) =>
  sessionStore.onMetaChange(cb);

/** The thread this plan handed off to: same plan file, a build type. */
function findSpawned(
  id: string,
  planPath: string | null | undefined,
): SessionMeta | null {
  if (!planPath) return null;
  return (
    sessionStore
      .metas()
      .find(
        (x) =>
          x.id !== id &&
          x.planPath === planPath &&
          x.threadType !== null &&
          x.threadType !== "planning",
      ) ?? null
  );
}

export function PlanView(props: ThreadViewProps) {
  const { session } = props;
  const running = session.status === "running" || session.status === "starting";
  const waiting = session.status === "waiting";
  const doc = usePlanFile(session.planPath, running);

  const sections = useMemo(() => splitSections(doc ?? ""), [doc]);
  const tasks = useMemo(() => planTasks(sections), [sections]);
  const hasDoc = sections.length > 0;

  // Revision wash: a settled section whose content changed flashes once.
  // The streaming tail (last section while running) is growth, not revision.
  const prevRef = useRef<Section[]>([]);
  const [flash, setFlash] = useState<Record<number, number>>({});
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = sections;
    if (prev.length === 0) return;
    const changed = sections
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => {
        if (running && i >= sections.length - 1) return false;
        const p = prev[i];
        return p !== undefined && p.body !== s.body;
      })
      .map(({ i }) => i);
    if (changed.length) {
      setFlash((f) => {
        const next = { ...f };
        for (const i of changed) next[i] = (next[i] ?? 0) + 1;
        return next;
      });
    }
  }, [sections, running]);

  // Outline: refs per section, active = last heading above the fold
  // (follows the stream while the agent writes).
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeSection, setActiveSection] = useState(0);
  const [prevLen, setPrevLen] = useState(sections.length);
  if (prevLen !== sections.length) {
    setPrevLen(sections.length);
    if (running) setActiveSection(sections.length - 1);
  }
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      let active = 0;
      sectionRefs.current.forEach((ref, i) => {
        if (ref && ref.offsetTop <= el.scrollTop + 96) active = i;
      });
      setActiveSection(active);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasDoc]);

  const spawned = useSyncExternalStore(subscribeMetas, () =>
    findSpawned(session.id, session.planPath),
  );

  // Chat pane phases: open alongside the plan while the conversation runs;
  // collapsed to the edge bar once the plan has handed off, and once the
  // turn settles with the plan written — the plan is the deliverable, the
  // chat is a click away. A pending question always forces it open —
  // answers live in the chat. All are render-time adjusts (the prevLen
  // pattern above), not effects, so a manual toggle wins until the next
  // phase change.
  const [chatOpen, setChatOpen] = useState(true);
  const [sawSpawned, setSawSpawned] = useState(!!spawned);
  if (!!spawned !== sawSpawned) {
    setSawSpawned(!!spawned);
    if (spawned) setChatOpen(false);
  }
  const [sawWaiting, setSawWaiting] = useState(waiting);
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting);
    if (waiting) setChatOpen(true);
  }
  const settledDoc = hasDoc && session.status === "idle";
  const [sawSettledDoc, setSawSettledDoc] = useState(settledDoc);
  if (settledDoc !== sawSettledDoc) {
    setSawSettledDoc(settledDoc);
    if (settledDoc) setChatOpen(false);
  }
  const collapsed = hasDoc && !chatOpen;

  const board = (
    <>
      {/* Plan pane header: identity on the left, its action on the
          right — Start until the handoff, then the running thread. */}
      <PaneHeader
        label="Plan"
        detail={tasks.length > 0 ? `${tasks.length} tasks` : null}
      >
        {spawned ? (
          <HandoffChip spawned={spawned} onOpen={() => props.onOpenSession?.(spawned.id)} />
        ) : (
          <AnimatePresence>
            {!running && !waiting ? <StartButton key="start" session={session} tasks={tasks} /> : null}
          </AnimatePresence>
        )}
      </PaneHeader>
      <div className="relative flex min-h-0 flex-1">
        {collapsed && sections.some((s) => s.heading) ? (
          <Outline
            sections={sections}
            active={activeSection}
            onJump={(i) =>
              sectionRefs.current[i]?.scrollIntoView({ behavior: "smooth" })
            }
          />
        ) : null}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto select-text"
        >
          <div className="mx-auto w-full max-w-3xl px-6 py-5">
            {sections.map((s, i) => (
              <div
                key={`${i}:${flash[i] ?? 0}`}
                ref={(el) => {
                  sectionRefs.current[i] = el;
                }}
                className={`-mx-3 rounded-lg px-3 ${
                  (flash[i] ?? 0) > 0
                    ? "z-plan-wash"
                    : ""
                }`}
              >
                <AgentMarkdown
                  text={s.body}
                  streaming={running && i === sections.length - 1}
                  cwd={session.cwd}
                  onOpenFile={props.onOpenFile}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );

  const chat = (
    <>
      {hasDoc ? (
        <PaneHeader label="Conversation">
          <button
            type="button"
            onClick={() => setChatOpen(false)}
            title="Hide conversation"
            aria-label="Hide conversation"
            className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </PaneHeader>
      ) : null}
      {props.renderChat({ topSlot: <FleetPulseLine sessionId={session.id} /> })}
    </>
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <SplitShell
        className="[contain:layout_style]"
        board={board}
        chat={chat}
        hasBoard={hasDoc}
        collapsed={collapsed}
        onOpenChat={() => setChatOpen(true)}
        status={session.status}
      />
      {/* Recon fleet: planning threads spawn explorers — the same panel the
          chat grows, folded to its edge tab once the fleet settles. */}
      <FleetSlot
        sessionId={session.id}
        parentCwd={session.cwd}
        onOpenSession={props.onOpenSession}
        onOpenFile={props.onOpenFile}
        onOpenDiff={props.onOpenDiff}
      />
    </div>
  );
}

/** Heading map down the left edge — only on the full-width plan. */
function Outline({
  sections,
  active,
  onJump,
}: {
  sections: Section[];
  active: number;
  onJump: (i: number) => void;
}) {
  return (
    <nav className="absolute top-6 bottom-4 left-4 hidden w-44 overflow-y-auto min-[1360px]:block">
      <div className="flex flex-col gap-px">
        {sections.map((s, i) =>
          s.heading === null ? null : (
            <button
              key={i}
              type="button"
              onClick={() => onJump(i)}
              className={`truncate rounded-md px-1.5 py-1 text-left text-xs leading-4 transition-colors ${
                s.level >= 3 ? "pl-4" : s.level === 2 ? "pl-2.5" : ""
              } ${i === active ? "text-content" : "text-content/40 hover:text-content/50"}`}
            >
              {s.heading}
            </button>
          ),
        )}
      </div>
    </nav>
  );
}

/** After Start: the pane header points at the thread working the plan. */
function HandoffChip({
  spawned,
  onOpen,
}: {
  spawned: SessionMeta;
  onOpen: () => void;
}) {
  const type: ThreadType = spawned.threadType ?? "implementation";
  const Glyph = THREAD_GLYPHS[type];
  const live = spawned.status === "running" || spawned.status === "starting";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pressable group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-content/50 hover:bg-content/5 hover:text-content"
    >
      <Glyph className={`size-3.5 ${THREAD_TINTS[type]}`} strokeWidth={1.75} />
      {THREAD_LABELS[type]} {live ? "running" : "finished"} ·{" "}
      {timeAgo(spawned.updatedAt)}
      <ChevronRight
        className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
        strokeWidth={1.75}
      />
    </button>
  );
}

/** Coordination brief for one of several parallel workers on one plan. */
const workerBrief = (i: number, n: number, title?: string): string =>
  n === 1
    ? `Implement the plan${title ? ` "${title}"` : ""}.`
    : `Implement the plan. You are worker ${i + 1} of ${n} working this plan in parallel. Coordinate ONLY through the plan file's ## Tasks checklist: re-read the plan file before picking each task; skip tasks that are ticked or marked in progress; when you pick one, append "(in progress: worker ${i + 1})" to its line, and replace that marker with a clean tick when done.`;

const ORCHESTRATION_BRIEF =
  "Orchestrate implementation of the plan across subagents.";

type BuildType = "implementation" | "orchestration";

const ACTION_ROW =
  "group/act flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-content/5 active:bg-content/10";
const ACTION_TILE =
  "flex size-8 shrink-0 items-center justify-center rounded-lg bg-content/5";

/** The plan pane's one action: hand the approved plan to builders — who
 *  (model + effort), how many, or an orchestrator that splits it itself. */
function StartButton({ session, tasks }: { session: Session; tasks: string[] }) {
  const reduce = useReducedMotion();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BuildType | null>(null);
  // The build's setup defaults to the planning thread's — change it here.
  const [choice, setChoice] = useState<{ harness: HarnessId; model: string }>({
    harness: session.harness,
    model: session.model,
  });
  const [settings, setSettings] = useState<Record<string, string>>(
    session.modelSettings,
  );
  const [mode, setMode] = useState<RuntimeMode>(session.runtimeMode);
  const [workers, setWorkers] = useState(1);
  // The build's finish line, derived from the plan; editable, clearable —
  // empty starts the thread with no goal.
  const [goal, setGoal] = useState(
    tasks.length > 0
      ? "Every task in the plan's checklist is checked off and typecheck passes"
      : "The plan is fully implemented and typecheck passes",
  );
  // Per-run orchestration tune: instructions and conduct overrides for
  // this one thread, over the Settings defaults.
  const [view, setView] = useState<"main" | "tune">("main");
  const [tune, setTune] = useState<ThreadRules>({});

  const start = async (type: BuildType): Promise<void> => {
    if (busy) return;
    setBusy(type);
    try {
      const base = sessionDisplayTitle(session.title, session.harness).replace(
        /^Plan:?\s*/i,
        "",
      );
      const n = type === "implementation" ? workers : 1;
      const rules = normalizeTune(tune);
      for (let i = 0; i < n; i++) {
        await startThread(
          {
            threadType: type,
            provider: choice.harness,
            model: nativeModelId(choice.model),
            reasoning: settings.effort,
            context1m: settings.context === "1m",
            permission: policyForMode(mode),
            projectId: session.projectId ?? null,
            workspaceId: session.workspaceId ?? null,
            cwd: session.cwd,
            planPath: session.planPath ?? undefined,
            goal: goal.trim() || undefined,
            title: n > 1 ? `${base} (${i + 1}/${n})` : base,
            ...(type === "orchestration" && rules ? { threadRules: rules } : {}),
          },
          type === "implementation"
            ? workerBrief(i, n, base)
            : ORCHESTRATION_BRIEF,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
      // The plan settling is a rare, earned moment — a touch of overshoot.
      transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.6 }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="pressable flex items-center gap-1.5 rounded-md bg-content px-3 py-1 text-[12px] font-medium text-background-base hover:bg-content/90"
      >
        <Play className="size-3.5 fill-current" strokeWidth={1.75} />
        Start
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="end"
          width={340}
          autoFocus
          tabIndex={-1}
          role="dialog"
          aria-label="Start building"
          ignore="[data-model-picker], [data-model-settings], [data-access-picker]"
          onDismiss={() => setOpen(false)}
        >
          {view === "tune" ? (
            <div className="py-2">
              <div className="flex items-center gap-1 px-2">
                <button
                  type="button"
                  onClick={() => setView("main")}
                  aria-label="Back"
                  className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
                >
                  <ChevronLeft className="size-3.5" strokeWidth={1.75} />
                </button>
                <span className="text-[13px] font-medium">Orchestration options</span>
              </div>
              <ThreadTune tune={tune} onChange={setTune} workspaceId={session.workspaceId ?? null} />
              <div className="px-3">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void start("orchestration")}
                  className="pressable mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-content text-[13px] font-medium text-background-base hover:bg-content/90 disabled:opacity-40"
                >
                  {busy === "orchestration" ? <MatrixSpinner cell={2} /> : "Orchestrate"}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Who builds it, and under what rules — the same knobs a new
              chat gets: model, effort, access. */}
              <div className="border-b border-content/10 px-3 pt-2.5 pb-2">
                <p className="text-[13px] font-medium">Start building</p>
                <div className="mt-1.5 -ml-1 flex flex-wrap items-center gap-1">
                  <ModelPicker
                    harness={choice.harness}
                    model={choice.model}
                    onChange={(h, m) => {
                      setChoice({ harness: h, model: m });
                      setSettings(mergeModelSettings(resolveModel(h, m), settings));
                    }}
                  />
                  <ModelSettings
                    harness={choice.harness}
                    model={choice.model}
                    values={settings}
                    onChange={setSettings}
                  />
                  <AccessPicker value={mode} onChange={setMode} />
                </div>
              </div>

              {/* The finish line the build works toward — clear it to
              start without a goal. */}
              <div className="flex items-center gap-2 border-b border-content/10 px-3 py-2">
                <CircleDot
                  className={`size-3.5 shrink-0 ${goal.trim() ? "text-accent" : "text-content/40"}`}
                  strokeWidth={1.75}
                />
                <input
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Keep working until… (optional)"
                  aria-label="Goal"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-content/40"
                />
                {goal ? (
                  <button
                    type="button"
                    onClick={() => setGoal("")}
                    aria-label="Clear goal"
                    className="pressable grid size-5 shrink-0 place-items-center rounded-md text-content/40 hover:text-content"
                  >
                    <X className="size-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
              </div>

              <div className="p-1">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void start("implementation")}
                  onKeyDown={(e) => e.key === "Enter" && void start("implementation")}
                  className={`${ACTION_ROW} ${busy ? "pointer-events-none opacity-60" : ""}`}
                >
                  <span className={ACTION_TILE}>
                    {busy === "implementation" ? (
                      <MatrixSpinner cell={2} />
                    ) : (
                      <ListChecks className="size-4 text-success" strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">Implement</span>
                    <span className="block text-xs text-content/50">Work the plan's tasks</span>
                  </span>
                  {/* How many parallel implementation threads. */}
                  <span
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 gap-0.5 rounded-md bg-content/5 p-0.5"
                  >
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setWorkers(n)}
                        aria-label={`${n} thread${n > 1 ? "s" : ""}`}
                        className={`flex size-5 items-center justify-center rounded-md text-xs transition-colors ${
                          workers === n
                            ? "bg-content/10 text-content"
                            : "text-content/50 hover:text-content"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </span>
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void start("orchestration")}
                  onKeyDown={(e) => e.key === "Enter" && void start("orchestration")}
                  className={`${ACTION_ROW} ${busy ? "pointer-events-none opacity-60" : ""}`}
                >
                  <span className={ACTION_TILE}>
                    {busy === "orchestration" ? (
                      <MatrixSpinner cell={2} />
                    ) : (
                      <GitFork className="size-4 text-violet" strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">Orchestrate</span>
                    <span className="block text-xs text-content/50">
                      {tuneSummary(tune) ?? "Split across subagents in parallel"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setView("tune");
                    }}
                    title="Instructions & rule overrides"
                    aria-label="Orchestration options"
                    className={`pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content ${
                      tuneSummary(tune) ? "opacity-100" : "opacity-0 group-hover/act:opacity-100"
                    }`}
                  >
                    <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {tasks.length > 0 ? (
                <div className="rounded-b-xl border-t border-content/10 bg-content/5 px-3 py-2">
                  {tasks.slice(0, 3).map((t, i) => (
                    <p key={i} className="truncate text-xs leading-[18px] text-content/50">
                      {i + 1}. {t}
                    </p>
                  ))}
                  {tasks.length > 3 ? (
                    <p className="text-xs leading-[18px] text-content/40">+{tasks.length - 3} more</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </Popover>
      ) : null}
    </motion.div>
  );
}
