import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Play } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { StatusMark, threadStateOf } from "../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta, ThreadType } from "../../lib/tcserver/types";
import { planTasks, splitSections, type Section } from "../../lib/threads/planDoc";
import { usePlanFile } from "../../hooks/usePlanFile";
import { projectPlanComplete } from "@server/shared/projectPlan";
import { loadProjectPlan, useProjectPlan } from "../../lib/projectPlan";
import { MilestoneList, ProjectPlanCard, ProjectPlanPin } from "./ProjectPlanCard";
import { AgentMarkdown } from "../AgentMarkdown";
import { THREAD_LABELS } from "./threadTypes";
import { SplitShell } from "./SplitShell";
import { StartBuildDialog } from "./StartBuildDialog";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Planning thread, in three phases. It opens as a normal chat while the
 * plan is being shaped. The moment the plan document has content, the
 * document takes the left of the split (draggable, double-click resets)
 * and the chat continues on the right. Once the plan has handed off, or
 * the turn settles with the plan written, the chat folds; the header's
 * toggle brings it back, and a question always forces it open. The
 * header carries the plan's one action: Start build until the handoff,
 * then the build it handed to.
 */

const subscribeMetas = (cb: () => void): (() => void) =>
  sessionStore.onMetaChange(cb);

/** The thread this plan handed off to: the one the server linked
 *  (implementationId), else any build on the same plan file. */
function findSpawned(
  id: string,
  planPath: string | null | undefined,
  implementationId?: string | null,
): SessionMeta | null {
  const linked = implementationId ? sessionStore.metaOf(implementationId) : null;
  if (linked) return linked;
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
  // A project plan (docs/PROJECT-PLAN.md): the same document view, with
  // the milestones live and the options card instead of Start.
  const projectPlan = session.threadType === "project-plan";
  const planState = useProjectPlan(projectPlan ? session.projectId : null);

  const sections = useMemo(() => splitSections(doc ?? ""), [doc]);
  const tasks = useMemo(() => (projectPlan ? [] : planTasks(sections)), [sections, projectPlan]);
  const hasDoc = sections.length > 0;
  // The project plan's ## Milestones renders as the live list: its own
  // `###` sections fold into it instead of printing as headings.
  const rendered = useMemo(() => {
    if (!projectPlan) return sections.map((s, i) => ({ s, i, milestones: false }));
    const out: { s: Section; i: number; milestones: boolean }[] = [];
    let inside = false;
    sections.forEach((s, i) => {
      if (s.level <= 2 && s.heading) inside = /^milestones$/i.test(s.heading);
      if (inside && s.level >= 3) return;
      out.push({ s, i, milestones: inside && s.level <= 2 });
    });
    return out;
  }, [sections, projectPlan]);
  const complete = projectPlan && !!doc && projectPlanComplete(doc);
  const milestoneDetail = useMemo(() => {
    if (!projectPlan || !planState?.milestones.length) return null;
    const done = planState.milestones.filter((m) => m.done).length;
    return `${done} of ${planState.milestones.length} milestone${planState.milestones.length === 1 ? "" : "s"} done`;
  }, [projectPlan, planState]);

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

  // A project plan hands off milestone by milestone, never as a whole:
  // the builds sharing its file are no handoff chip.
  const spawnedRaw = useSyncExternalStore(subscribeMetas, () =>
    findSpawned(session.id, session.planPath, session.implementationId),
  );
  const spawned = projectPlan ? null : spawnedRaw;

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

  const [starting, setStarting] = useState(false);
  const headerDetail = projectPlan
    ? milestoneDetail
    : tasks.length > 0
      ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}`
      : null;
  const headerActions = projectPlan ? (
    <ProjectPlanPin
      projectId={session.projectId}
      pinned={planState?.pinned ?? false}
      onChanged={() => session.projectId && void loadProjectPlan(session.projectId)}
    />
  ) : spawned ? (
    <HandoffButton spawned={spawned} onOpen={() => props.onOpenSession?.(spawned.id)} />
  ) : !running && !waiting ? (
    <Button size="sm" onClick={() => setStarting(true)}>
      <Play />
      Start build
    </Button>
  ) : null;

  const board = (
    <>
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
          <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
            {rendered.map(({ s, i, milestones }) => (
              <div
                key={i}
                ref={(el) => {
                  sectionRefs.current[i] = el;
                }}
              >
                <AgentMarkdown
                  className="text-[15px] leading-[1.6]"
                  text={s.body}
                  streaming={running && i === sections.length - 1}
                  cwd={session.cwd}
                  onOpenFile={props.onOpenFile}
                />
                {milestones && doc ? (
                  <MilestoneList
                    doc={doc}
                    projectId={session.projectId}
                    onTicked={() => session.projectId && void loadProjectPlan(session.projectId)}
                  />
                ) : null}
              </div>
            ))}
            {complete && doc && !running && !waiting ? (
              <ProjectPlanCard
                session={session}
                doc={doc}
                state={planState}
                onStarted={(id) => props.onOpenSession?.(id)}
                onChanged={() => session.projectId && void loadProjectPlan(session.projectId)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );

  const chat = props.renderChat();

  return (
    <div className="relative flex min-h-0 flex-1">
      <SplitShell
        className="[contain:layout_style]"
        board={board}
        chat={chat}
        hasBoard={hasDoc}
        collapsed={collapsed}
        onToggleChat={setChatOpen}
        title={projectPlan ? "Project plan" : "Plan"}
        detail={headerDetail}
        actions={headerActions}
      />
      {!projectPlan && !spawned ? (
        <StartBuildDialog session={session} tasks={tasks} open={starting} onOpenChange={setStarting} />
      ) : null}
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
    <nav aria-label="Outline" className="absolute top-6 bottom-4 left-4 hidden w-44 overflow-y-auto min-[1360px]:block">
      <div className="flex flex-col">
        {sections.map((s, i) =>
          s.heading === null ? null : (
            <Button
              key={i}
              variant="ghost"
              size="xs"
              onClick={() => onJump(i)}
              aria-current={i === active ? "location" : undefined}
              className={`justify-start truncate font-normal ${
                s.level >= 3 ? "pl-6" : s.level === 2 ? "pl-4" : ""
              } ${i === active ? "text-foreground" : "text-muted-foreground"}`}
            >
              <span className="truncate">{s.heading}</span>
            </Button>
          ),
        )}
      </div>
    </nav>
  );
}

/** The build's kind, as a noun. */
const BUILD_NOUN: Partial<Record<ThreadType, string>> = {
  implementation: "Implementation",
  orchestration: "Orchestration",
};

/** After Start: the header points at the thread working the plan. */
function HandoffButton({ spawned, onOpen }: { spawned: SessionMeta; onOpen: () => void }) {
  const type: ThreadType = spawned.threadType ?? "implementation";
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="sm" onClick={onOpen} />}>
        {BUILD_NOUN[type] ?? THREAD_LABELS[type]}
        <StatusMark className="ml-2" state={threadStateOf(spawned.status, { settled: true })} />
      </TooltipTrigger>
      <TooltipContent>Open the build</TooltipContent>
    </Tooltip>
  );
}
