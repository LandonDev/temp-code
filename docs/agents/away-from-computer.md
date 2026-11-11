# Away from computer: threads finish without the person

- The state is the person's, one copy per host: `{ enabled, at, by }` and
  the stretch's tally of decisions per thread in the settings table
  (`away`, `away:decided`; src/main/server/away.ts `AwayService`,
  src/shared/away.ts). `away.get` (read), `away.set` (approve: it answers
  every thread's approvals), `away.apply` (admin, the peer leg) and the
  `away` push (src/shared/contract-away.ts). No home host: the Mac sends a
  flip to every link, applies the box's push when newer and never sends it
  back, and link-up settles both ways, newest wins
  (remote/awaySync.ts; docs/box.md "Away from computer: one state on every
  host"). Only a person turns it off.
- The words (src/main/server/awayPrompts.ts): `AWAY_MECHANICS` rides every
  prompt beside the steer rule (claude's system prompt through
  `mechanicsFor`, other harnesses' first message through threads.ts), with
  the `<away state="on">` block while away is on at spawn. The registry
  keeps what each live harness was told (`awayToldAs`): a flip whispers the
  block into every running or waiting turn (`awayChanged`), every other
  thread catches up ahead of its next turn (`takeNotices`: a send, the turn
  pass, a reports wake), so on and off again while idle tells it nothing.
  A master's report gathers its batch's decisions.
- The host backs the prompt up (sessions.ts `interceptAway`,
  `requestApproval`, in the emit path): while away, a question is answered
  with `AWAY_QUESTION_REPLY` as each question's typed answer and every
  approval is ALLOWED (since 2026-11-10; before, every one was denied):
  tool cards in safe and edits, the add-on and skill cards (`addon_add`
  too: the host stands in for the admin), every computer card and the
  session step's card (Run now). One kind is still denied: a computer act
  the model flagged `pay` or `subscribe` (`awayAllowsKind`,
  `AWAY_DENIED_KINDS` in src/shared/away.ts, read off the call's own
  `confirm`, never a card's input; computer/run.ts raises that card with
  `ApprovalRequest.awayDenies`), with `AWAY_APPROVAL_REPLY`. An allow
  remembers nothing (no bridge rule, no Skip). The request's row, its
  `waiting` and its resolved row are never written, so nothing reads Needs
  you and the notifier stays quiet; a driver with no resolver yet gets the
  card as usual after one retry. Turning away on answers the cards already
  waiting the same way (`Store.unresolvedRequests`, the newest rows only;
  the registry keeps each pending card's `awayDenies`). The Mac decides
  its own calls by its own Away state: a bridge read (secret paths too),
  command, job or write that would ask is allowed at once, quiet, and
  marked on its reply (`ctx.markAway` → `peer.reply { away: true }`,
  `PeerCalls.call`'s `onAway`), its prompts waiting at the flip decided by
  `MacBridge.awayChanged`; a box thread's computer call is allowed and
  says `away` in its answer, or refused with `MAC_AWAY_REFUSAL` when it
  spends money. The box writes the row (macTools.ts `awayAware`,
  computer/bridge.ts), and words a Mac on the older build's refusal
  (`MAC_AWAY_REFUSAL_LEGACY`) as a skipped row. Each of these, and each
  `note_decision` call (an app tool on every thread, `app.noteDecision`
  over the codex bridge; the same decision again in one away stretch
  answers "already noted" and writes no second row, `awayNotice`), is one
  `notice` of kind `away`
  (`away: { kind: decision | question | allowed | approval, text }`;
  `approval` is a denial, "Skipped while away", `allowed` "Allowed while
  away", drawn with the open lock) that counts toward the tally.
- The app: the rail foot's Away row above Settings (chrome/AwayRow.tsx, a
  switch on lib/away.ts, its track from components/ui/switch-track.ts),
  Threads → Away from Computer (a checkbox row, `MenuState.checked`), the
  away notice line folded into the run, and on the way back one toast
  "Decided without you in N threads" with Review (chrome/AwayReturn.tsx,
  AwayReviewDialog in the dialogs chunk). The phone only decodes the rows.
- Proof: `bun run script:e2e-away` (a haiku thread asks a question while
  away and finishes without a card; a safe-mode haiku thread's Bash write
  is allowed with no card; a flip off reaches a running turn); unit tests
  away, awaySync, sessions-away, macBridge, macBridgeWrite, macJobs,
  macTools, peerCalls, macComputer, computer/bridge, approval, schedule,
  the drivers' allows and denials, AwayRow.dom, AwayReturn.dom.
