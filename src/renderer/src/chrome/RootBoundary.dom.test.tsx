import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootBoundary } from "./RootBoundary";
import { rendererErrorLine, reportRendererError, tagRendererError } from "../lib/rendererErrors";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new TypeError("cannot read 'x' of undefined");
}

describe("RootBoundary", () => {
  it("renders its children while nothing throws", () => {
    render(
      <RootBoundary>
        <main data-app>app</main>
      </RootBoundary>,
    );
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a render error leaves one line and Reload window, which reloads", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <RootBoundary reload={reload}>
        <Broken />
      </RootBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Something broke");
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("rendererErrorLine", () => {
  it("is one line naming the kind, the error's name and its message", () => {
    expect(rendererErrorLine("uncaught", new TypeError("bad\nthing"))).toBe("uncaught TypeError: bad thing");
    expect(rendererErrorLine("caught", "plain")).toBe("caught string: plain");
    expect(rendererErrorLine("uncaught", new Error("x".repeat(500))).length).toBe(300);
  });

  it("reports through the given reporter and survives one that throws; a caught line waits a microtask for the boundary's tag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lines: string[] = [];
    reportRendererError("uncaught", new RangeError("deep"), (l) => lines.push(l));
    expect(lines).toEqual(["uncaught RangeError: deep"]);
    expect(() =>
      reportRendererError("caught", new Error("x"), () => {
        throw new Error("no link");
      }),
    ).not.toThrow();
    const held = new TypeError("bad");
    reportRendererError("caught", held, (l) => lines.push(l));
    tagRendererError(held, { thread: "m1", row: "r1" });
    expect(lines).toHaveLength(1);
    await Promise.resolve();
    expect(lines[1]).toBe("caught TypeError: bad thread=m1 row=r1");
    const long = new Error("x".repeat(500));
    tagRendererError(long, { thread: "m1", row: "r1" });
    expect(rendererErrorLine("caught", long).length).toBe(300);
    expect(rendererErrorLine("caught", long).endsWith(" thread=m1 row=r1")).toBe(true);
  });
});
