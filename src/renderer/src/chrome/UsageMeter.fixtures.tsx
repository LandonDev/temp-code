// The usage meter's three states for `bun run ui:preview src/renderer/src/chrome/UsageMeter.fixtures.tsx#…`:
// the rail row in a rail-wide column and the popover's body in a popover-wide card.
import type { UsageMeter } from "@server/shared/usageMeter";
import { MeterDetails, MeterRowView } from "./UsageMeter";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const pooled: UsageMeter = {
  share: 0.62,
  resetsAt: NOW + 2 * HOUR + 10 * MIN,
  limited: null,
  withRoom: 3,
  windows: [
    { label: "5h", name: "5h", share: 0.71, resetsAt: NOW + 2 * HOUR + 10 * MIN },
    { label: "Weekly", name: "Week", share: 0.58, resetsAt: NOW + 76 * HOUR },
    { label: "Fable", name: "Fable", share: 0.06, resetsAt: NOW + 30 * HOUR },
  ],
};

const limited: UsageMeter = {
  share: 0.34,
  resetsAt: NOW + 50 * MIN,
  limited: { until: NOW + 3 * MIN },
  withRoom: 0,
  windows: [
    { label: "5h", name: "5h", share: 0.08, resetsAt: NOW + 50 * MIN },
    { label: "week", name: "Week", share: 0.6, resetsAt: NOW + 100 * HOUR },
  ],
};

const empty: UsageMeter = { share: null, resetsAt: null, limited: null, withRoom: 0, windows: [] };

function Rows({ claude, codex }: { claude: UsageMeter; codex: UsageMeter }) {
  return (
    <div className="flex w-[260px] flex-col gap-px bg-sidebar px-2 py-2">
      <MeterRowView provider="claude" meter={claude} now={NOW} />
      <MeterRowView provider="codex" meter={codex} now={NOW} />
    </div>
  );
}

function Card({ meter, provider = "claude" }: { meter: UsageMeter; provider?: "claude" | "codex" }) {
  return (
    <div className="flex w-64 flex-col gap-3 rounded-xl bg-popover p-3 text-sm ring-1 ring-border">
      <MeterDetails provider={provider} meter={meter} now={NOW} />
    </div>
  );
}

export const RowsPooled = () => <Rows claude={pooled} codex={limited} />;
export const RowsEmpty = () => <Rows claude={empty} codex={pooled} />;
export const DetailsPooled = () => <Card meter={pooled} />;
export const DetailsLimited = () => <Card meter={limited} provider="codex" />;
export const DetailsEmpty = () => <Card meter={empty} />;
