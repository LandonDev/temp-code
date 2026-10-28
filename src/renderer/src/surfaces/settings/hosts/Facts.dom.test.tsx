// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Facts, splitFacts } from "./Facts";

afterEach(cleanup);

describe("Facts", () => {
  it("draws each fact as its own span, with no separator character", () => {
    const { container } = render(<Facts parts={["118 of 120 running", "7 queued"]} />);
    const spans = container.querySelectorAll("[data-slot=facts] > span");
    expect([...spans].map((s) => s.textContent)).toEqual(["118 of 120 running", "7 queued"]);
    expect(container.textContent).not.toContain("·");
  });
  it("draws nothing for no facts", () => {
    const { container } = render(<Facts parts={[]} />);
    expect(container.innerHTML).toBe("");
  });
  it("splits a dotted line from another module into facts", () => {
    expect(splitFacts("2 simulators, 1 booted · load 3.2 / 16 cores")).toEqual(["2 simulators, 1 booted", "load 3.2 / 16 cores"]);
    expect(splitFacts(" one ·  two · ")).toEqual(["one", "two"]);
  });
});
