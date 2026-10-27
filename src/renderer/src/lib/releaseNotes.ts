import release from "../../../../release.json";

/**
 * The running release's notes come from release.json (written by
 * scripts/release.ts at tag time); a waiting release's notes arrive on the
 * update feed. The Keep-a-Changelog parser (releaseNotesParse.ts, out of
 * the first paint) still serves feed notes that are a full changelog section.
 */
export const BUNDLED_RELEASE = {
  // The same number the app reports (package.json 1.0.N), so the feed's
  // versions and the bundled one compare like for like.
  version: `1.0.${release.n}`,
  notes: release.notes,
  date: new Date(release.ts).toISOString().slice(0, 10),
};

export type ReleaseNotesTabSource = {
  version: string;
};

export type ReleaseNotesDocument = {
  source: ReleaseNotesTabSource;
  markdown: string;
};

export function releaseNotesTitle(version: string): string {
  return `What's new in release ${version}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatReleaseDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
