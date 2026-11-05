// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RevealTurnContext, revealDrainForTest, useReportReveal, useTurnRevealing } from "./revealDrain";

afterEach(() => {
  cleanup();
  revealDrainForTest.reset();
});

function Row({ on }: { on: boolean }) {
  useReportReveal(on);
  return null;
}

function Watcher({ turn }: { turn: string }) {
  return <span data-testid={turn}>{String(useTurnRevealing(turn))}</span>;
}

describe("the reveal's drain, by turn", () => {
  it("says a turn reveals while any of its rows does, and drains when the last stops or leaves", () => {
    const tree = (a: boolean, b: boolean, showB = true) => (
      <>
        <RevealTurnContext.Provider value="t1">
          <Row on={a} />
          {showB ? <Row on={b} /> : null}
        </RevealTurnContext.Provider>
        <Watcher turn="t1" />
        <Watcher turn="t2" />
      </>
    );
    const view = render(tree(true, true));
    const t1 = () => view.getByTestId("t1").textContent;
    expect(t1()).toBe("true");
    expect(view.getByTestId("t2").textContent).toBe("false");
    view.rerender(tree(false, true));
    expect(t1()).toBe("true");
    view.rerender(tree(false, true, false));
    expect(t1()).toBe("false");
  });

  it("reports nothing outside a transcript", () => {
    const view = render(
      <>
        <Row on />
        <Watcher turn="t1" />
      </>,
    );
    expect(view.getByTestId("t1").textContent).toBe("false");
  });
});
