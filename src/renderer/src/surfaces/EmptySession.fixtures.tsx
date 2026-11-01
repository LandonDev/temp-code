// A stand-in box where the composer sits, so the static render shows its place.
export default [
  {
    name: "Draft",
    props: { composer: <div className="h-28 rounded-xl border border-border bg-card" /> },
  },
  {
    // The project's remembered draft, back with its text in the first frame.
    name: "Restored draft",
    props: {
      composer: (
        <div className="h-28 rounded-xl border border-border bg-card p-3 text-sm text-foreground">
          Rework the login flow so a lapsed token asks once
        </div>
      ),
    },
  },
];
