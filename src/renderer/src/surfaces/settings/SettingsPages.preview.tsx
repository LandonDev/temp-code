import { useState, type ReactNode } from "react";
import { CATALOG } from "@server/shared/catalog";
import { DEFAULT_PLAN_SETTINGS } from "@server/shared/plans";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { DEFAULT_RULES, withProbedDefaults } from "@server/shared/rules";
import { Page } from "../../components/page";
import { registry, type Link } from "../../lib/connection";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { bindServer } from "../../lib/native";
import { dropHarnessAvailability } from "../../lib/harness/availability";
import { resetCatalogProbes } from "../../lib/tcserver/catalog";
import { resetPlanSettingsForTests } from "../../lib/tcserver/plans";
import { rulesStore, type RulesCatalog } from "../../lib/tcserver/rules";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { ReviewsPage } from "../ReviewSettings";
import { EditorPage } from "./Editor";
import { GeneralPage } from "./General";
import { HostsPage } from "./hosts/HostsPage";
import { KeybindingsPage } from "./Keybindings";
import { OrchestrationPage } from "./Orchestration";
import { ProvidersPage } from "./Providers";
import { ThreadDefaultsPage } from "./ThreadDefaults";
import { WorkspacePage } from "./Workspace";
import { AppearancePage } from "./Appearance";

/**
 * Every Settings page over one fixed host, for `bun run ui:preview
 * src/renderer/src/surfaces/settings/SettingsPages.preview.tsx#SettingsPagePreview`
 * (the fixtures beside it): the page as its host answers it (`answers`),
 * while the host has not answered (`silent`: the skeletons in their shape),
 * and once it refused (`refuses`: each section's error and Retry). The
 * registry and the stores are pointed at one fake link that answers at once,
 * so the preview's one flush after the mount shows the page loaded. Rendered
 * by nothing in the app.
 */

export type HostMode = "answers" | "silent" | "refuses";

const WORKSPACE = { id: "w1", name: "temp-code", path: "/srv/agents/work/temp-code", git: true, githubRepo: "LandonDev/temp-code", createdAt: 1 };

const ANSWERS: Record<string, unknown> = {
  "doctor.get": {
    claude: { found: true, version: "2.1.263 (Claude Code)" },
    codex: { found: true, version: "codex-cli 0.162.1", error: "Login expired" },
    cursor: { found: false },
    java: { found: true, version: "21.0.4", jdtls: true, path: "/usr/lib/jvm/java-21", ideaServer: { dist: true, accepted: true, build: "263.2689" } },
  },
  "lsp.status": [
    { serverId: "s1", lang: "java", projectId: "p1", state: "running", memoryBytes: 612 * 1024 ** 2, idleMs: 240_000 },
    { serverId: "s2", lang: "web", projectId: "p1", state: "error", error: "Exited 1", idleMs: 0 },
  ],
  "linear.status": { connected: true },
  "linear.teams": [
    { id: "t1", name: "Core", key: "COR" },
    { id: "t2", name: "Web", key: "WEB" },
  ],
  "rules.get": { rules: withProbedDefaults(DEFAULT_RULES), overridden: true },
  "catalog.get": Object.fromEntries(Object.values(CATALOG).map((p) => [p.id, p])) as RulesCatalog,
  "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: false },
  "plans.get": { settings: DEFAULT_PLAN_SETTINGS, overridden: false },
  "review.get": { override: null, global: DEFAULT_REVIEW_SETTINGS, settings: DEFAULT_REVIEW_SETTINGS, source: "global" },
  "turnpass.get": { verify: true, build: false, commit: "off" },
  "build.get": { command: "bun run build", outputs: "out/**" },
  "build.detect": { command: "bun run build", outputs: "out/**" },
  "workspace.list": [WORKSPACE],
  "project.list": [],
  "remote.status": {
    environmentId: "env_1gP-MhkVVRaMwHbVCysYow",
    name: "This Mac",
    enabled: true,
    port: 7677,
    configuredPort: 7677,
    running: true,
    error: null,
    origin: "http://127.0.0.1:7677",
    publicOrigin: "",
    learnedOrigin: "https://tempcode.landonhale.com",
    contract: 1,
    stuckMinutes: 30,
  },
  "remote.keys.list": [
    { id: "k1", name: "iPhone", audience: "client", caps: ["read", "operate", "approve"], kind: "bearer", createdAt: 1, lastUsedAt: null, revokedAt: null, createdBy: "local", webhookUrl: null, events: null },
  ],
  "remote.pairings.list": [],
  "remote.sessions.list": [],
  "remote.environments.list": [],
  "attachment.settings": { maxBytes: 64 * 1024 * 1024 },
};

let mode: HostMode = "answers";
const CATALOG_LISTS = new Set(["workspace.list", "project.list", "catalog.get"]);

/** The one link every page reads through: answers at once, never, or with a refusal. */
const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    // The catalog's own lists always answer: the fixtures are about the pages' reads.
    if (!CATALOG_LISTS.has(method)) {
      if (mode === "silent") return new Promise<T>(() => {});
      if (mode === "refuses") return Promise.reject(new Error(NO_ANSWER));
    }
    return method in ANSWERS ? Promise.resolve(ANSWERS[method] as T) : Promise.reject(new Error(`no ${method}`));
  },
} as unknown as Link;

Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
// Linear's reads go through lib/native's server router, which the app binds at boot.
bindServer({ linkOf: () => link });

/** A fresh host for each fixture: the stores forget what an earlier fixture loaded. */
function prepare(next: HostMode): void {
  mode = next;
  resetPlanSettingsForTests();
  resetCatalogProbes();
  dropHarnessAvailability("local");
  rulesStore.reset();
  rulesStore.attach(link);
  workspaceStore.reset();
  workspaceStore.attach(link);
}

const PAGES: Record<string, { title: string; description?: string; body: () => ReactNode }> = {
  general: { title: "General", body: () => <GeneralPage onOpenWhatsNew={() => {}} /> },
  defaults: { title: "Thread defaults", body: () => <ThreadDefaultsPage /> },
  appearance: { title: "Appearance", body: () => <AppearancePage /> },
  editor: { title: "Editor", body: () => <EditorPage /> },
  keybindings: { title: "Keybindings", body: () => <KeybindingsPage /> },
  providers: { title: "Providers", body: () => <ProvidersPage /> },
  orchestration: { title: "Orchestration", body: () => <OrchestrationPage /> },
  reviews: { title: "Reviews", body: () => <ReviewsPage /> },
  hosts: { title: "Hosts", body: () => <HostsPage /> },
  workspace: { title: "temp-code", description: "/srv/agents/work/temp-code", body: () => <WorkspacePage workspaceId="w1" /> },
};

export function SettingsPagePreview({ page, host }: { page: keyof typeof PAGES; host: HostMode }) {
  useState(() => prepare(host));
  const { title, description, body } = PAGES[page];
  return (
    <Page title={title} description={description}>
      {body()}
    </Page>
  );
}
