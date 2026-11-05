// Fixtures for `bun run ui:preview src/renderer/src/chrome/CommandPopover.preview.tsx#SlashMenuPreview`.
const cmd = (name: string, description: string, source: string, scope = "user") => ({ name, description, source, scope });

export default [
  {
    name: "The slash menu open on /re",
    props: {
      active: 0,
      matches: {
        mode: "command",
        rows: [
          cmd("review", "Review the current diff for correctness bugs", "command"),
          cmd("release", "Cut and publish a release", "command", "project"),
          cmd("refactor", "Restructure code without changing behaviour", "skill"),
          cmd("research", "Investigate a question across the codebase", "skill"),
        ],
      },
    },
  },
  { name: "No match on /zzz", props: { active: 0, matches: { mode: "command", rows: [] } } },
  { name: "An @ while the project's files are read", props: { active: 0, matches: { mode: "file", rows: [], loading: true } } },
];
