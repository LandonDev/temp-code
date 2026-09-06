// Type-only view of the server contract. The source of truth lives in
// server/shared; nothing from there runs in the webview.
export type {
  CreateSessionInput,
  ServerResponse,
  QueuedMessage,
  SessionBatchResult,
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

// Fork-only contract pieces the server gains in M3a (session.pin, catalog
// pushes). Typed here so the renderer compiles against today's server;
// fold these back into the re-exports above once the server has them.
export type SessionMeta = import("@server/shared/events").SessionMeta & {
  /** kept at the top of the sidebar list */
  pinned?: boolean;
};
export type ServerPush =
  | import("@server/shared/contract").ServerPush
  | { push: "workspaces"; workspaces: import("@server/shared/domain").WorkspaceMeta[] }
  | { push: "projects"; projects: import("@server/shared/domain").ProjectMeta[] };
export type ServerFrame = import("@server/shared/contract").ServerResponse | ServerPush;
export type { ThreadType, SlashCommand } from "@server/shared/domain";
export type { ThreadDefaults } from "@server/shared/defaults";
export type {
  WorkspaceMeta,
  ProjectMeta,
  ProjectMode,
  WorkspaceIcon,
  ProjectCleanup,
  BranchList,
} from "@server/shared/domain";
