import release from "../../../../release.json";

/**
 * The running release's notes, from release.json (written by
 * scripts/release.ts at tag time). Loaded only where they are read (Settings,
 * the changelog parser, What's New through `import()`), never in the first
 * paint: the notes are every commit subject since the last release.
 */
export const BUNDLED_RELEASE = {
  // The same number the app reports (package.json 1.0.N), so the feed's
  // versions and the bundled one compare like for like.
  version: `1.0.${release.n}`,
  notes: release.notes,
  date: new Date(release.ts).toISOString().slice(0, 10),
};
