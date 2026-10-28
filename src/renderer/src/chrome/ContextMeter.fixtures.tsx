// Fixtures for `bun run ui:preview src/renderer/src/chrome/ContextMeter.tsx#ContextMeter` (the
// meter at rest) and `#ContextBreakdown` (its popover's body): one list serves both.
import type { ContextReading } from "../lib/contextCache";

const reading: ContextReading = {
  totalTokens: 80_000,
  maxTokens: 200_000,
  percentage: 40,
  categories: [
    { name: "System prompt", tokens: 3_100 },
    { name: "System tools", tokens: 14_800 },
    { name: "MCP tools", tokens: 6_200 },
    { name: "Memory files", tokens: 4_300 },
    { name: "Messages", tokens: 51_600 },
    { name: "Free space", tokens: 0 },
  ],
  memoryFiles: [
    { path: "/srv/agents/home/.claude/CLAUDE.md", tokens: 2_400 },
    { path: "/srv/agents/work/temp-code/CLAUDE.md", tokens: 1_200 },
    { path: "/srv/agents/work/temp-code/docs/CLAUDE.md", tokens: 310 },
    { path: "/srv/agents/work/temp-code/ios/CLAUDE.md", tokens: 180 },
    { path: "/srv/agents/work/temp-code/infra/CLAUDE.md", tokens: 90 },
    { path: "/srv/agents/work/temp-code/scripts/CLAUDE.md", tokens: 60 },
    { path: "/srv/agents/work/temp-code/src/CLAUDE.md", tokens: 40 },
    { path: "/srv/agents/work/temp-code/out/CLAUDE.md", tokens: 20 },
  ],
  mcpTools: [
    { name: "mcp__linear__list_issues", server: "linear", tokens: 1_900 },
    { name: "mcp__linear__get_issue", server: "linear", tokens: 1_400 },
    { name: "mcp__convex__run", server: "convex", tokens: 1_100 },
    { name: "mcp__convex__data", server: "convex", tokens: 900 },
    { name: "mcp__mobbin__search_screens", server: "mobbin", tokens: 600 },
    { name: "mcp__mobbin__search_flows", server: "mobbin", tokens: 300 },
  ],
};

export default [
  {
    name: "40% with the breakdown, its lists past six, and Compact",
    props: { sessionId: "s", usage: { used: 80_000, window: 200_000 }, reading, compactable: true, onCompact: "fn" },
  },
  {
    name: "88%: amber",
    props: {
      sessionId: "s",
      usage: { used: 176_000, window: 200_000 },
      reading: { ...reading, totalTokens: 176_000, percentage: 88 },
      compactable: true,
      onCompact: "fn",
    },
  },
  {
    name: "Compacting",
    props: { sessionId: "s", usage: { used: 120_000, window: 200_000 }, reading, compacting: true, busy: true },
  },
  {
    name: "Loading: before the first reading",
    props: { sessionId: "s", usage: { used: 30_000, window: 400_000 }, reading: null },
  },
  {
    name: "Mid-turn with no reading yet",
    props: { sessionId: "s", usage: { used: 30_000, window: 400_000 }, reading: null, busy: true },
  },
];
