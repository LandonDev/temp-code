/**
 * Where a setting's one copy lives when another host holds it: the
 * orchestration rules and the thread defaults are kept on the box
 * (remote/rulesSync.ts), and the host answers `rules.get` / `defaults.get`
 * with that host's name and whether it answers now.
 */
export type SettingsHome = { name: string; online: boolean };

/** The host's `home` off the wire; anything else is none. */
export function readHome(raw: unknown): SettingsHome | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, online } = raw as Record<string, unknown>;
  return typeof name === "string" && typeof online === "boolean" ? { name, online } : null;
}

/** The line a settings section prints for it: "Saved on box", or "box is offline" with the controls off. */
export function homeNote(home: SettingsHome | null | undefined): { note: string | undefined; blocked: boolean } {
  if (!home) return { note: undefined, blocked: false };
  return home.online ? { note: `Saved on ${home.name}`, blocked: false } : { note: `${home.name} is offline`, blocked: true };
}
