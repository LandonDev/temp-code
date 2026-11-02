import { describe, expect, it, vi } from "vitest";

/**
 * React's development build writes a `performance.measure` for every
 * component re-render with changed props, named with a zero-width space and
 * the component (its Performance panel track). react-dom 19.2.8 never
 * cleared them: a dev window kept every one, about 1.2 KB of native memory
 * each, 51,000 a minute on the box (.temp-code/perf1/box/dev-findings.md).
 * 19.3.1 clears each one right after it is made. This holds the upgrade.
 */
describe("React's development build", () => {
  it("leaves no component measure on the timeline after 200 changed-props renders", async () => {
    // React logs its component track only where console.timeStamp exists,
    // which jsdom's console lacks; React reads that once at load, so the
    // two modules load fresh here, after it is in place.
    const console_ = console as unknown as { timeStamp?: () => void };
    console_.timeStamp ??= () => {};
    vi.resetModules();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    performance.clearMeasures();

    const Leaf = ({ n }: { n: number }) => React.createElement("span", null, n);
    const Row = ({ n, onPick }: { n: number; onPick: () => void }) =>
      React.createElement("button", { onClick: onPick }, React.createElement(Leaf, { n }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    for (let i = 0; i < 200; i++) {
      await React.act(async () => root.render(React.createElement(Row, { n: i, onPick: () => {} })));
    }
    expect(host.textContent).toBe("199");
    const left = performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("​"));
    expect(left.length, `React ${React.version} kept ${left.length} component measures`).toBe(0);
    await React.act(async () => root.unmount());
    host.remove();
  });
});
