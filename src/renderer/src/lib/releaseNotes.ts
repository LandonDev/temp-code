/**
 * A release's notes as a tab: its title, its date, its document. The
 * running release's own notes are lib/bundledRelease.ts (release.json, out
 * of the first paint: its notes grow with every release); a waiting
 * release's notes arrive on the update feed. The Keep-a-Changelog parser
 * (releaseNotesParse.ts, out of the first paint) still serves feed notes
 * that are a full changelog section.
 */

export type ReleaseNotesTabSource = {
  version: string;
};

export type ReleaseNotesDocument = {
  source: ReleaseNotesTabSource;
  markdown: string;
};

/** What What's New and the release notes tab say for a version with no notes: one sentence for one state. */
export const NO_RELEASE_NOTES = "No release notes for this version";

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
