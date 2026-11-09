// Fixtures for `bun run ui:preview src/renderer/src/surfaces/settings/SettingsPages.preview.tsx#SettingsPagePreview`:
// every Settings page as its host answers it, then the pages that read a host while it is silent and once it refused.
// SETTINGS_PREVIEW=editor,hosts keeps those pages' fixtures alone, so each page's shots stay readable.
const PAGES = [
  "general",
  "defaults",
  "appearance",
  "editor",
  "keybindings",
  "providers",
  "addons",
  "skills",
  "addons-empty",
  "skills-empty",
  "addons-offline",
  "skills-offline",
  "orchestration",
  "reviews",
  "hosts",
  "workspace",
] as const;
const READS = new Set<string>(["general", "defaults", "editor", "providers", "addons", "skills", "orchestration", "reviews", "hosts", "workspace"]);
const only = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SETTINGS_PREVIEW?.split(",");
const shown = PAGES.filter((page) => !only || only.includes(page));

export default shown.flatMap((page) => [
  { name: `${page}: the host answered`, props: { page, host: "answers" } },
  ...(READS.has(page)
    ? [
        { name: `${page}: the host has not answered`, props: { page, host: "silent" } },
        { name: `${page}: the host refused`, props: { page, host: "refuses" } },
      ]
    : []),
]);
