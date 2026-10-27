import { GitFork, ListChecks, MapIcon, MessageSquare, Milestone, Search, Telescope, Users, Wrench } from "../../chrome/icons";
import type { AgentType, ThreadType } from "../../lib/tcserver/types";

/** Every thread type's glyph, label, tint and hint, and each subagent role's glyph. */

type Glyph = typeof MessageSquare;

export const THREAD_TYPES: ThreadType[] = [
  "chat",
  "planning",
  "project-plan",
  "implementation",
  "orchestration",
  "research",
];

export const THREAD_GLYPHS: Record<ThreadType, Glyph> = {
  chat: MessageSquare,
  planning: MapIcon,
  "project-plan": Milestone,
  implementation: ListChecks,
  orchestration: GitFork,
  research: Telescope,
};

export const THREAD_LABELS: Record<ThreadType, string> = {
  chat: "Chat",
  planning: "Plan",
  "project-plan": "Project plan",
  implementation: "Implement",
  orchestration: "Orchestrate",
  research: "Research",
};

/** What the new-thread chooser calls a type when its row is an action, not a noun. */
export const THREAD_START_LABELS: Partial<Record<ThreadType, string>> = {
  "project-plan": "Plan the project…",
};

/** Identity tint per thread type — the glyph carries it, nothing else. */
export const THREAD_TINTS: Record<ThreadType, string> = {
  chat: "text-info",
  planning: "text-violet",
  "project-plan": "text-violet",
  implementation: "text-success",
  orchestration: "text-warning",
  research: "text-cyan",
};

/** Subagent glyph by role, for fleet rows and nested sidebar rows. */
export const AGENT_GLYPHS: Record<AgentType, Glyph> = {
  orchestrator: Users,
  implementer: Wrench,
  reviewer: ListChecks,
  explorer: Search,
};

export const THREAD_HINTS: Record<ThreadType, string> = {
  chat: "Ask questions, explore the code",
  planning: "Produce a plan document to implement from",
  "project-plan": "Survey the whole project, lay out its milestones",
  implementation: "Execute a task, todos in focus",
  orchestration: "Spawn and direct subagents",
  research: "Investigate with parallel explorers, produce a cited report",
};
