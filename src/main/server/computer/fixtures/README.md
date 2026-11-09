# Computer-use fixtures

What the computer-use contract (docs/computer-protocol.md) is tested against.
Everything here is scratch content: nothing comes from the person's own
windows, and the repository is public. `computerFixtures.test.ts` holds every
file to its schema and to the privacy guard.

## `wire/`

Hand-written JSON-RPC frames, one file each, every one parsed by its schema
in the vitest suite and decoded by `ComputerProtocolTests` in
native/tc-computer.

- `<method>.request.json` and `<method>.response.json` for each of the 16
  methods of `COMPUTER_METHODS` (src/shared/computer/protocol.ts), with ids,
  realistic params and results (TextEdit's probe document).
- `error-<kind>.json` for each `ComputerErrorKind`. A kind a request can be
  refused with is a JSON-RPC error frame (`code` -32000, the `ComputerError`
  as `data`); a kind only a step carries (`STEP_ONLY_ERROR_KINDS`) is an
  `action.run` result whose step failed.
- `notify-<method>.json` for each notification, the service's and the
  host's: the method with `$/` dropped and `/` turned into `-`
  (`notify-capture-frame.json`, `notify-cancel.json`,
  `notify-capture.stream.ack.json`).

Add a file when you add a method, an error kind or a notification; the
tests fail on any that has none.

## `keys/combos.json`

The key-combo vectors both parsers are held to: Anthropic's examples, every
key name and modifier alias, `+` as a key, single characters and refusals,
each `{ input, ok, modifiers (print order), key, text }`. `keyCombos.test.ts`
holds `parseKeyCombo` in observation.ts to them and `KeyComboTests` in
native/tc-computer/Tests/InputTests holds KeyCombo.swift; regenerate the
expected values from the TypeScript parser only when the grammar changes.

## `observations/`

Hand-written observation texts, one per grammar case: `full`, `diff`,
`unchanged`, `truncated`, `thin`, `stub` (JetBrains rows with no text),
`loading`, `geometry`, `menus` and `escapes` (quotes, tabs, newlines,
controls, emoji, right-to-left text, cut names and values). Each must parse
with `parseObservation` and format back to the same text. `escapes.txt` is
easier to change through `formatObservation` than by hand, since names and
values are JSON strings written the way `JSON.stringify` writes them.

## `page/form.html`

The test page the Chrome fixtures show: inputs, a select, a checkbox, a radio
group, a button that opens a dialog, a link, 60 list rows (most of them
below the fold) and a button that shows a spinner for 3 s.

## `page/heavy.html` and `page/rebuild.html`

The AX reader's live proof (`scripts/mac/ax-reader-proof.sh`) shows these in
the throwaway Chrome. `heavy.html` builds about 3,000 accessibility nodes at
load (40 headings with 400 paragraphs, a 300-row table, 200 nav links, a
30-field form) for the read timings. `rebuild.html` has 20 labelled inputs,
half with a DOM id, and two buttons that replace the list with identical
markup or with one value changed: every element under it is a new AX element,
so the reader's rebuilt-element rule keeps their numbers or it does not.

## `apps/<app>/<state>/`

Real accessibility trees and screenshots, recorded on the Mac:

- `tree.json`: `RawAXTree`, every element the window holds, visible or not,
  with its raw attributes, actions and settable attributes.
- `window.jpg`: the window at a long edge of 1280 px.
- `meta.json`: `FixtureMeta`: when, on what, the setup steps in words, and
  the state and action this one followed (`textedit/typed` follows
  `textedit/doc`), so the AX reader can test its diff on real pairs.
- `appshot.txt`: `appshot-helper axdump` of the same window (today's flat
  text, for comparison), only for processes that hold nothing but scratch
  windows.
- `observation.txt`: added by the AX reader, its own output for the tree;
  the grammar tests parse it.

The states are `textedit/{doc,typed,save-sheet}`,
`chrome/{form,menu-open,loading}`, `tempcode-dev/{first-run,thread}` and
`intellij/project`.

### Recording them again

On the Mac, in a clone (never the person's checkout), with Accessibility and
Screen Recording granted to the process that runs it:

```
TC_FIXTURE_CLONE=<built clone> scripts/mac/record-computer-fixtures.sh [textedit] [chrome] [tempcode-dev] [intellij]
```

`scripts/mac/record-computer-fixtures.sh` sets up each scratch state and
cleans it up after: a separate TextEdit instance with its persistence off, a
second Chrome on a throwaway profile showing `page/form.html` (with
`--force-renderer-accessibility`, or the page never reaches the AX tree), a
TempCode dev instance on fresh data in `/tmp`, and a scratch IntelliJ project
opened as a new window of the IDE. `textedit/save-sheet` is the sheet the
close button asks with (keep the new document?), not Save As: Command-S needs
the instance in front, and in front it took the person's keystrokes. A
Chrome select's menu is a popup window of its own, drawn into the shot
(`shot.popups`). `scripts/mac/record-computer-fixture.swift` records
one window: it takes the exact window title and refuses any other, and
rewrites the home directory to `/Users/me`, the host name to `mac` and the
account's full name to `Me` in everything it writes.

Before a commit, a person looks at every `window.jpg`. The privacy guard
fails on a path under `/Users/` other than `/Users/me`, on an email address
outside `example.com`, and on any string from the deny list in the file
`TC_FIXTURE_DENY` names (kept outside the repository; the check is skipped
when it is unset).
