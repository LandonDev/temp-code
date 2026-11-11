import { useState, type ReactNode } from "react";
import { CATALOG } from "@server/shared/catalog";
import { DEFAULT_PLAN_SETTINGS } from "@server/shared/plans";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { DEFAULT_RULES, withProbedDefaults } from "@server/shared/rules";
import { Page } from "../../components/page";
import { registry, type Link } from "../../lib/connection";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { bindServer } from "../../lib/native";
import { settingsSectionDescription } from "../../lib/settings";
import { dropHarnessAvailability } from "../../lib/harness/availability";
import { registerBuiltinHarnesses } from "../../lib/harness/register";
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
import { AddonsPage } from "./addons/AddonsPage";
import { SkillsPage } from "./skills/SkillsPage";
import { ComputerPage } from "./Computer";
import { computerSessionsStore } from "../../lib/computerSessions";
import type { ComputerServiceState, ComputerSettings } from "@shared/contract-computer";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonStatus } from "@shared/contract-addons";
import type { SkillMeta } from "@shared/contract-skills";

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

// Settings → Add-ons and Skills: four add-ons (Connected, Failed, Needs a key, Off; one a thread wrote) and three skills.
const addon = (over: Partial<AddonRow> & { name: string }): AddonRow => ({
  id: `ad_${over.name}`,
  workspaceId: null,
  description: "",
  spec: { transport: "stdio", command: "npx", args: [], env: [], auth: "none" },
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const ADDONS: AddonRow[] = [
  addon({
    name: "github",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"], auth: "fields" },
    writtenBy: { kind: "thread", sessionId: "s1", environmentId: "local", title: "Fix the build" },
  }),
  addon({ name: "linear", spec: { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], auth: "oauth" } }),
  addon({ name: "slack", workspaceId: "w1", spec: { transport: "http", url: "https://slack.example.com/mcp", headers: ["X-Api-Key"], auth: "fields", platforms: ["darwin"] } }),
  addon({ name: "playwright", enabled: false, spec: { transport: "stdio", command: "npx", args: ["@playwright/mcp"], env: [], auth: "none" } }),
];
const at = (state: AddonStatus["state"], over: Partial<AddonStatus> = {}): AddonStatus => ({ state, tools: 0, at: 1, ...over });
const ADDON_STATUS: Record<string, AddonStatus> = {
  ad_github: at("ready", { tools: 24 }),
  ad_linear: at("failed", { detail: "Disconnected: the server closed the stream" }),
  ad_slack: at("needs-grant", { detail: "Needs values for X-Api-Key" }),
  ad_playwright: at("off"),
};
const GRANTS: AddonGrantView[] = [
  { addonId: "ad_github", fields: [{ name: "GITHUB_TOKEN", set: true }], oauth: null, signIn: null, gaps: [] },
  { addonId: "ad_linear", fields: [], oauth: { signedIn: true, expiresAt: null, refreshedBy: "box", refused: false }, signIn: null, gaps: [] },
];
const skill = (over: Partial<SkillMeta> & { name: string; description: string }): SkillMeta => ({
  id: `sk_${over.name}`,
  workspaceId: null,
  harnesses: "all",
  enabled: true,
  version: 1,
  digest: "d",
  bytes: 4096,
  fileCount: 1,
  addedBy: { kind: "import", from: "~/.claude/skills" },
  writtenBy: { kind: "import", from: "~/.claude/skills" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const SKILLS: SkillMeta[] = [
  skill({
    name: "impeccable",
    description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface",
    version: 3,
    writtenBy: { kind: "thread", sessionId: "s2", environmentId: "local", title: "Polish the rail" },
  }),
  skill({ name: "release-notes", description: "Write the release notes from the commit subjects since the last tag", harnesses: ["claude", "codex"], workspaceId: "w1" }),
  skill({ name: "swift-review", description: "Review Swift for data races and retain cycles", harnesses: ["codex"], enabled: false, version: 2 }),
];
const STORE_ANSWERS = {
  "addons.list": { addons: ADDONS, status: ADDON_STATUS, home: { name: "box", online: true } },
  "addons.grant.list": { grants: GRANTS },
  "skills.list": { skills: SKILLS, home: { name: "box", online: true } },
};
Object.assign(ANSWERS, STORE_ANSWERS);

// Settings → Computer use: five learned apps (two may take the screen, one saved before names were kept), Screen Recording off.
const COMPUTER_SETTINGS: ComputerSettings = {
  sessionIdleMs: 120_000,
  activeApp: "brief",
  apps: [
    { bundleId: "com.apple.TextEdit", name: "TextEdit", classes: { click: "process", type: "process" }, updatedAt: 1 },
    { bundleId: "com.google.Chrome", name: "Google Chrome", classes: { click: "session", scroll: "session", type: "session" }, updatedAt: 1 },
    { bundleId: "com.apple.calculator", name: "Calculator", classes: { key: "session" }, updatedAt: 1 },
    { bundleId: "com.apple.finder", name: "Finder", classes: { click: "process" }, updatedAt: 1 },
    { bundleId: "com.example.Legacy", name: null, classes: {}, updatedAt: 1 },
  ],
};
Object.assign(ANSWERS, {
  "computer.settings.get": COMPUTER_SETTINGS,
  "computer.permissions": { accessibility: true, screenRecording: false },
});
const COMPUTER_UP: ComputerServiceState = { state: "up", pid: 4242, epoch: "e1", restarts: 0, permissions: { accessibility: true, screenRecording: false } };
const COMPUTER_DOWN: ComputerServiceState = {
  state: "down",
  reason: "tc-computer crashed 5 times in two minutes: fatal error",
  until: 1,
  restarts: 5,
  permissions: null,
};
const OFFLINE = { name: "box", online: false };

let mode: HostMode = "answers";
/** The page's own answers over the shared ones (an empty list, an offline home). */
let overrides: Record<string, unknown> = {};
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
    if (method in overrides) return Promise.resolve(overrides[method] as T);
    return method in ANSWERS ? Promise.resolve(ANSWERS[method] as T) : Promise.reject(new Error(`no ${method}`));
  },
} as unknown as Link;

Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
// The live harnesses, as the app registers them at boot: the Model picker lists the CLIs the host found.
registerBuiltinHarnesses();
// Linear's reads go through lib/native's server router, which the app binds at boot.
bindServer({ linkOf: () => link });

/** A fresh host for each fixture: the stores forget what an earlier fixture loaded. */
function prepare(next: HostMode, answers: Record<string, unknown> = {}, service: ComputerServiceState = COMPUTER_UP): void {
  mode = next;
  overrides = answers;
  // The service state rides the host's `computer` push; a silent host has sent none.
  computerSessionsStore.setState({ serviceByHost: next === "silent" ? {} : { local: service } });
  resetPlanSettingsForTests();
  resetCatalogProbes();
  dropHarnessAvailability("local");
  rulesStore.reset();
  rulesStore.attach(link);
  workspaceStore.reset();
  workspaceStore.attach(link);
}

const PAGES: Record<
  string,
  { title: string; description?: string; body: () => ReactNode; answers?: Record<string, unknown>; service?: ComputerServiceState }
> = {
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
  addons: { title: "Add-ons", description: "MCP servers every thread can use.", body: () => <AddonsPage /> },
  skills: { title: "Skills", description: settingsSectionDescription("skills"), body: () => <SkillsPage /> },
  computer: { title: "Computer use", description: settingsSectionDescription("computer"), body: () => <ComputerPage /> },
  "computer-empty": {
    title: "Computer use",
    description: settingsSectionDescription("computer"),
    body: () => <ComputerPage />,
    answers: { "computer.settings.get": { ...COMPUTER_SETTINGS, apps: [] }, "computer.permissions": { accessibility: true, screenRecording: true } },
    service: { ...COMPUTER_UP, state: "idle", permissions: null },
  },
  "computer-down": {
    title: "Computer use",
    description: settingsSectionDescription("computer"),
    body: () => <ComputerPage />,
    answers: { "computer.settings.get": { ...COMPUTER_SETTINGS, apps: COMPUTER_SETTINGS.apps.slice(1, 2) } },
    service: COMPUTER_DOWN,
  },
  "addons-empty": {
    title: "Add-ons",
    description: "MCP servers every thread can use.",
    body: () => <AddonsPage />,
    answers: { "addons.list": { addons: [], status: {}, home: null }, "addons.grant.list": { grants: [] } },
  },
  "skills-empty": { title: "Skills", description: settingsSectionDescription("skills"), body: () => <SkillsPage />, answers: { "skills.list": { skills: [], home: null } } },
  "addons-offline": {
    title: "Add-ons",
    description: "MCP servers every thread can use.",
    body: () => <AddonsPage />,
    answers: { "addons.list": { ...STORE_ANSWERS["addons.list"], home: OFFLINE } },
  },
  "skills-offline": {
    title: "Skills",
    description: settingsSectionDescription("skills"),
    body: () => <SkillsPage />,
    answers: { "skills.list": { ...STORE_ANSWERS["skills.list"], home: OFFLINE } },
  },
};

/** Thread defaults' "New threads start on" asks only once a second host is saved. */
const TWO_HOSTS = [
  { id: "local", name: "This Mac", routes: [], credentialRef: "local" },
  { id: "env_box", name: "box", routes: [], credentialRef: "env_box" },
];
const ownEnvironments = registry.environmentsSnapshot.bind(registry);

export function SettingsPagePreview({ page, host }: { page: keyof typeof PAGES; host: HostMode }) {
  useState(() => {
    Object.assign(registry, { environmentsSnapshot: page === "defaults" ? () => TWO_HOSTS : ownEnvironments });
    prepare(host, PAGES[page].answers, PAGES[page].service);
  });
  const { title, description, body } = PAGES[page];
  return (
    <Page title={title} description={description}>
      {body()}
    </Page>
  );
}
