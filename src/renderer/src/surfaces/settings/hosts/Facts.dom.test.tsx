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
  it("sets facts 4px apart as one comma sentence, never by space alone", () => {
    const { container } = render(<Facts parts={["App", "never used"]} />);
    const facts = container.querySelector<HTMLElement>("[data-slot=facts]")!;
    expect(facts.className).toContain("gap-x-1");
    expect(facts.className).not.toContain("gap-x-2");
    expect(facts.className).toContain("[&>span:not(:last-child)]:after:content-[',']");
  });

  it("leaves out an absent fact and takes a fact of its own tone", () => {
    const { container } = render(<Facts parts={[null, "Opus", false, <b key="w">Not approved</b>]} />);
    expect([...container.querySelectorAll("[data-slot=facts] > span")].map((s) => s.textContent)).toEqual(["Opus", "Not approved"]);
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
