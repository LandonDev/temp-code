// The empty thread with the real composer in its place: the same box and row
// the docked footer draws, so the first send moves it without resizing it.
import { Composer } from "../chrome/Composer";
import { composerFixtureBase } from "../chrome/Composer.fixtures";

export default [
  {
    name: "Draft",
    props: { composer: <Composer {...composerFixtureBase} sessionId={undefined} shell hideProjectPicker /> },
  },
  {
    // The project's remembered draft, back with its text in the first frame.
    name: "Restored draft",
    props: {
      composer: (
        <Composer
          {...composerFixtureBase}
          sessionId={undefined}
          shell
          hideProjectPicker
          initialDraft="Rework the login flow so a lapsed token asks once"
        />
      ),
    },
  },
];
