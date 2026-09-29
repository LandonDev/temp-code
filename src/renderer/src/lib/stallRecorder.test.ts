import { describe, expect, it } from "vitest";
import { createStallRecorder, STALL_MS, type StallContext } from "./stallRecorder";

function harness() {
  const lines: string[] = [];
  let clock = 1000;
  const pushes = { session: 0, event: 0 };
  const paints: (() => void)[] = [];
  const ctx: StallContext = {
    pushes: () => ({ ...pushes }),
    pendingMethods: () => ["session.events", "queue.list"],
    runningCount: () => 4,
    visibility: () => "visible",
  };
  const recorder = createStallRecorder({
    ctx,
    report: (line) => lines.push(line),
    now: () => clock,
    afterPaint: (fn) => paints.push(fn),
  });
  return {
    lines,
    pushes,
    recorder,
    advance: (ms: number) => (clock += ms),
    paint: () => paints.splice(0).forEach((fn) => fn()),
  };
}

describe("stall recorder (renderer)", () => {
  it("a long task line carries the last switch, the second's pushes, pending requests, running count and visibility", () => {
    const h = harness();
    h.pushes.session = 30;
    h.pushes.event = 120;
    h.recorder.switched("tab-switch", "tab-9");
    h.advance(400);
    h.recorder.longtask(320);
    expect(h.lines).toEqual([
      "longtask 320ms switch=tab-switch:tab-9@400ms pushes=session:30,event:120 pending=session.events,queue.list running=4 visibility=visible",
    ]);
  });

  it("ignores tasks under the threshold and forgets a switch older than five seconds", () => {
    const h = harness();
    h.recorder.longtask(STALL_MS - 1);
    expect(h.lines).toEqual([]);
    h.recorder.switched("page-switch", "settings");
    h.advance(6000);
    h.recorder.longtask(200);
    expect(h.lines[0]).toContain("switch=- ");
  });

  it("a switch logs when its paint lands late, and stays quiet when it is quick", () => {
    const h = harness();
    h.recorder.switched("page-switch", "inbox");
    h.advance(40);
    h.paint();
    expect(h.lines).toEqual([]);
    h.recorder.switched("tab-switch", "tab-2");
    h.advance(900);
    h.paint();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^switch tab-switch:tab-2 900ms switch=tab-switch:tab-2@900ms /);
  });

  it("pushes count the previous full second plus the current one, settled by tick", () => {
    const h = harness();
    h.pushes.session = 5;
    h.recorder.tick();
    h.pushes.session = 12;
    h.recorder.longtask(200);
    expect(h.lines[0]).toContain("pushes=session:12,event:0");
    h.recorder.tick();
    h.recorder.tick();
    h.recorder.longtask(200);
    expect(h.lines[1]).toContain("pushes=session:0,event:0");
  });

  it("writes at most ten lines a second and refills on tick", () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.recorder.longtask(200);
    expect(h.lines).toHaveLength(10);
    h.recorder.tick();
    h.recorder.longtask(200);
    expect(h.lines).toHaveLength(11);
    h.recorder.dispose();
    h.recorder.longtask(200);
    expect(h.lines).toHaveLength(11);
  });
});
