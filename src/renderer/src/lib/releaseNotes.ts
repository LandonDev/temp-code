import bundledChangelog from "../../CHANGELOG.md?raw";
import release from "../../../../release.json";

/**
 * The running release's notes come from release.json (written by
 * scripts/release.ts at tag time); a waiting release's notes arrive on the
 * update feed. The Keep-a-Changelog parser below still serves feed notes
 * that are a full changelog section.
 */
export const BUNDLED_RELEASE = {
  // The same number the app reports (package.json 1.0.N), so the feed's
  // versions and the bundled one compare like for like.
  version: `1.0.${release.n}`,
  notes: release.notes,
  date: new Date(release.ts).toISOString().slice(0, 10),
};

function bundledReleaseMarkdown(): string {
  return `## [${BUNDLED_RELEASE.version}] - ${BUNDLED_RELEASE.date}\n\n${BUNDLED_RELEASE.notes}`;
}

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

export function releaseNotesForVersion(
  version: string,
  changelog: string = bundledChangelog,
): ReleaseNotesDocument | null {
  const normalized = version.trim();
  if (!normalized || normalized === "Unreleased") return null;
  if (changelog === bundledChangelog && normalized === BUNDLED_RELEASE.version) {
    return { source: { version: normalized }, markdown: bundledReleaseMarkdown() };
  }

  const escapedVersion = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\r?$`,
    "gm",
  );
  const match = heading.exec(changelog);
  if (!match) return null;

  const nextHeading = /^## /gm;
  nextHeading.lastIndex = match.index + match[0].length;
  const next = nextHeading.exec(changelog);
  const markdown = changelog.slice(match.index, next?.index).trimEnd();

  return {
    source: { version: normalized },
    markdown,
  };
}

export function releaseNotesMarkdown(
  source: ReleaseNotesTabSource,
  changelog: string = bundledChangelog,
): string | null {
  return releaseNotesForVersion(source.version, changelog)?.markdown ?? null;
}

export type ReleaseNotesPresentation = {
  version: string;
  date: string | null;
  markdown: string;
};

/** Changelog body for the What's new modal: version heading lives in the chrome. */
export function presentReleaseNotes(
  version: string,
  changelog: string = bundledChangelog,
): ReleaseNotesPresentation | null {
  const release = releaseNotesForVersion(version, changelog);
  if (!release) return null;

  const escapedVersion = release.source.version.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\r?\\n*`,
  );
  const match = heading.exec(release.markdown);

  return {
    version: release.source.version,
    date: match?.[1] ?? null,
    markdown: match
      ? release.markdown.slice(match[0].length).trimStart()
      : release.markdown,
  };
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
