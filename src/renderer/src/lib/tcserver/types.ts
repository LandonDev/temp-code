// Type-only view of the server contract. The source of truth lives in
// server/shared; nothing from there runs in the webview.
export type {
  CreateSessionInput,
  ServerFrame,
  ServerPush,
  ServerResponse,
  QueuedMessage,
  SessionBatchResult,
} from "@server/shared/contract";
export type {
  AgentEvent,
  EventRow,
  SessionMeta,
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
export type {
  WorkspaceMeta,
  ProjectMeta,
  ProjectMode,
  WorkspaceIcon,
  ProjectCleanup,
  BranchList,
} from "@server/shared/domain";
