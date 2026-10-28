import { createElement } from "react";
import type { MenuIcon } from "../../chrome/menuRows";
import { GitFork, type IconProps, ListChecks, MapIcon, MessageSquare, Milestone, Search, Telescope, Users, Wrench } from "../../chrome/icons";
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

/** Each type's tint class, written out whole so Tailwind generates it. */
const TYPE_TINTS: Record<ThreadType, string> = {
  chat: "text-type-chat",
  planning: "text-type-planning",
  "project-plan": "text-type-project-plan",
  implementation: "text-type-implementation",
  orchestration: "text-type-orchestration",
  research: "text-type-research",
};

/** A type's tint class (docs/DESIGN.md "Type tints"): its glyph's colour
 *  and nothing else, never a title, fill or border. An unknown or absent
 *  type is drawn as chat. `TypeGlyph` is its one consumer. */
export function typeTint(type: ThreadType | null | undefined): string {
  return TYPE_TINTS[type && Object.hasOwn(TYPE_TINTS, type) ? type : "chat"];
}

/** Each type's glyph as a menu row's icon, tinted; module level, so a row's
 *  icon keeps its identity between renders. */
export const THREAD_MENU_ICONS = {} as Record<ThreadType, MenuIcon>;
for (const type of THREAD_TYPES) {
  const Glyph = THREAD_GLYPHS[type];
  // JSX leaves data-* unchecked; an object literal does not, so the props are cast once here.
  const props = { "aria-hidden": true, "data-type-glyph": type, className: typeTint(type) } as IconProps;
  const Icon = ({ strokeWidth }: { strokeWidth?: number }) => createElement(Glyph, { ...props, strokeWidth });
  Icon.displayName = `TypeMenuIcon(${type})`;
  THREAD_MENU_ICONS[type] = Icon;
}

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
