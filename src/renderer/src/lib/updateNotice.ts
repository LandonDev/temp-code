const INSTALLED_UPDATE_KEY = "monocode.installedUpdate";

export type UpdateNoticeStore = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type InstalledUpdate = {
  version: string;
};

export function rememberInstalledUpdate(
  version: string,
  store?: UpdateNoticeStore,
): void {
  const normalized = version.trim();
  if (!normalized) return;
  try {
    const target = store ?? window.localStorage;
    target.setItem(
      INSTALLED_UPDATE_KEY,
      JSON.stringify({ version: normalized }),
    );
  } catch {
    return;
  }
}

/**
 * The marker is written when a download is ready or the user asks for the
 * restart, before anything is installed. Only a boot that is actually
 * running that version shows "Updated to X"; any other boot (the install
 * failed, the app was relaunched as the old build) drops the marker and
 * leaves the failure to the updater status. Without `runningVersion` the
 * marker is consumed as is (tests, callers that checked already).
 */
export function consumeInstalledUpdate(
  store?: UpdateNoticeStore,
  runningVersion?: string,
): InstalledUpdate | null {
  try {
    const target = store ?? window.localStorage;
    const stored = target.getItem(INSTALLED_UPDATE_KEY);
    if (stored == null) return null;
    target.removeItem(INSTALLED_UPDATE_KEY);
    const update = parseInstalledUpdate(JSON.parse(stored));
    if (!update || runningVersion === undefined) return update;
    return update.version === runningVersion.trim() ? update : null;
  } catch {
    return null;
  }
}

function parseInstalledUpdate(raw: unknown): InstalledUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const version = (raw as Record<string, unknown>).version;
  if (typeof version !== "string" || !version.trim()) return null;
  return { version: version.trim() };
}
