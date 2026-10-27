// Type-only view of the server contract. The source of truth lives in
// server/shared; nothing from there runs in the webview.
export type {
  CreateSessionInput,
  ServerFrame,
  ServerPush,
  ServerResponse,
  QueuedMessage,
  SessionBatchResult,
  TaskLog,
} from "@server/shared/contract";
export type {
  AgentEvent,
  EventRow,
  PermissionPolicy,
  Attachment as ServerAttachment,
  ToolPreview as ServerToolPreview,
} from "@server/shared/events";
export type {
  ProviderId,
  ProviderInfo,
  ModelInfo,
  Reasoning,
  AgentType,
} from "@server/shared/catalog";
export type { SessionStatus } from "@server/shared/events";

export type { ThreadType, SlashCommand } from "@server/shared/domain";
export type { ThreadDefaults } from "@server/shared/defaults";
export type { ThreadRules } from "@server/shared/rules";
export type {
  ProjectMode,
  WorkspaceIcon,
  ProjectCleanup,
  BranchList,
} from "@server/shared/domain";

// ── Scoped by environment (thread K1) ──────────────────────────────────────
// The wire shapes carry no environment: the link that delivered a meta
// knows it, and the stores stamp it on the way in. Session ids are unique
// across hosts; workspaces and projects belong to the host they came from.
import type { SessionMeta as WireSessionMeta } from "@server/shared/events";
import type { ProjectMeta as WireProjectMeta, WorkspaceMeta as WireWorkspaceMeta } from "@server/shared/domain";

export type SessionMeta = WireSessionMeta & { environmentId: string };
export type ProjectMeta = WireProjectMeta & { environmentId: string };
export type WorkspaceMeta = WireWorkspaceMeta & { environmentId: string };
export type { WireSessionMeta, WireProjectMeta, WireWorkspaceMeta };
