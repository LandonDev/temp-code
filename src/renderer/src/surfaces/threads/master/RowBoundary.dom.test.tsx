import { act, fireEvent } from "@testing-library/react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportRendererError } from "../../../lib/rendererErrors";
import { RowBoundary } from "./RowBoundary";

/**
 * A board row whose record throws paints as "Couldn't load" with Retry,
 * its siblings paint, and stalls.log gets one caught line naming the
 * master thread and the row. The root is React's own (createRoot with
 * onCaughtError, as main.tsx mounts it), so the line goes the way it does
 * in the app: React logs the error, then the boundary tags it.
 */

let broken = true;
function Row({ id }: { id: string }) {
  if (broken && id === "bad") throw new TypeError("Cannot read properties of undefined (reading 'replace')");
  return <div data-row={id}>{id}</div>;
}

const microtask = () => act(() => Promise.resolve());

afterEach(() => {
  broken = true;
  vi.restoreAllMocks();
});

describe("RowBoundary", () => {
  it("a throwing row paints the fallback and reports once with the thread and the row; its siblings paint; Retry mounts it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lines: string[] = [];
    const container = document.body.appendChild(document.createElement("div"));
    const root = ReactDOM.createRoot(container, { onCaughtError: (error) => reportRendererError("caught", error, (l) => lines.push(l)) });
    const board = (
      <ul>
        {["good", "bad", "other"].map((id) => (
          <li key={id}>
            <RowBoundary threadId="m1" rowId={id}>
              <Row id={id} />
            </RowBoundary>
          </li>
        ))}
      </ul>
    );
    await act(() => root.render(board));
    await microtask();
    expect([...container.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["good", "other"]);
    const failed = container.querySelector("[data-chunk-failed='board-row.bad']")!;
    expect(failed).not.toBeNull();
    expect(failed.querySelector("[role='alert']")?.textContent).toBe("Couldn't loadRetry");
    expect(lines).toEqual(["caught TypeError: Cannot read properties of undefined (reading 'replace') thread=m1 row=bad"]);

    broken = false;
    await act(() => fireEvent.click(failed.querySelector("button")!));
    expect([...container.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["good", "bad", "other"]);
    expect(container.querySelector("[data-chunk-failed]")).toBeNull();
    await microtask();
    expect(lines).toHaveLength(1);
    await act(() => root.unmount());
    container.remove();
  });
});
