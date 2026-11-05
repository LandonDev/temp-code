// The failure card's Pick another account list, as the popover shows it.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 5, 15, 0);

const claude = {
  pinned: null,
  owner: "temp-code",
  profiles: [
    { name: "main", email: "landon@example.com", nickname: "Main", color: "#60a5fa", active: true, static: true, expiresAt: now + 200 * DAY },
    { name: "work", email: "work@example.com", nickname: "Work", color: "#a78bfa" },
    { name: "spare", email: "spare@example.com", duplicate: true },
  ],
  reports: [
    {
      profileName: "main",
      windows: [
        { label: "5h", usedPercent: 38, resetsAt: now + 2 * HOUR, periodMs: 5 * HOUR },
        { label: "week", usedPercent: 61, resetsAt: now + 3 * DAY, periodMs: 7 * DAY },
      ],
      plan: { name: "Max 20x", monthlyUsd: 200, renewsAt: now + 7 * DAY },
    },
    {
      profileName: "work",
      windows: [
        { label: "5h", usedPercent: 94, resetsAt: now + HOUR, periodMs: 5 * HOUR },
        { label: "week", usedPercent: 80, resetsAt: now + 2 * DAY, periodMs: 7 * DAY },
      ],
      plan: { name: "Max 5x", monthlyUsd: 100, cancelsAt: now + 9 * DAY },
    },
    { profileName: "spare", windows: [], rateLimit: { until: now + 40 * 60_000 } },
  ],
  headroom: { main: { room: 0.7, ratePerMin: 3, seenAt: now }, work: { room: 0.1, ratePerMin: 9, seenAt: now } },
};

const scope = { provider: "claude", inherited: null, current: "main", shown: "main" };

export default [
  { name: "Claude, a thread in scope", props: { provider: "claude", accounts: claude, scope, now } },
  {
    name: "Meta keys",
    props: {
      provider: "meta",
      now,
      scope: { provider: "meta", inherited: null, current: "Work", shown: "Work" },
      accounts: {
        pinned: null,
        owner: "temp-code",
        profiles: [
          { name: "Work", static: true, kind: "key", color: "#34d399" },
          { name: "Old", static: true, kind: "key" },
        ],
        reports: [
          { profileName: "Work", windows: [], note: "pay as you go" },
          { profileName: "Old", windows: [], expired: true, note: "key revoked" },
        ],
        headroom: { Work: { room: 0.8, ratePerMin: 4, seenAt: now } },
      },
    },
  },
];
