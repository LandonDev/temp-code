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
  {
    // Four columns and long names: 52.25rem of table, wider than an 800px window, so the popover caps it and the rows stack.
    name: "Four columns, long names",
    props: {
      provider: "claude",
      now,
      scope: null,
      accounts: {
        pinned: "long",
        owner: "temp-code",
        profiles: [
          { name: "long", email: "a-very-long-sign-in-address-for-the-team@example.com", color: "#60a5fa", active: true },
          { name: "other", email: "another-quite-long-address@example.com", nickname: "Second team account with a long nickname" },
        ],
        reports: ["long", "other"].map((profileName, i) => ({
          profileName,
          windows: [
            { label: "5h", usedPercent: 30 + i * 40, resetsAt: now + 2 * HOUR, periodMs: 5 * HOUR },
            { label: "week", usedPercent: 50, resetsAt: now + 3 * DAY, periodMs: 7 * DAY },
            { label: "week (Opus)", usedPercent: 20 + i * 50, resetsAt: now + 4 * DAY, periodMs: 7 * DAY },
          ],
        })),
        headroom: { long: { room: 0.6, ratePerMin: 2, seenAt: now }, other: { room: 0.2, ratePerMin: 8, seenAt: now } },
      },
    },
  },
];
