// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MacBridgeRule } from "@server/shared/contract-macbridge-rules";
import { macBridgeRulesStore } from "../lib/macBridgeRules";
import { MacBridgeRuleList } from "./MacBridgeRemember";

/** A thread's remembered approvals: Remove on each row and Forget all, never a solid red button in a row. */
afterEach(() => {
  cleanup();
  macBridgeRulesStore.setState({ rules: [], loaded: false });
});

describe("MacBridgeRuleList", () => {
  it("draws Remove and Forget all as muted ghosts that turn red on hover", () => {
    macBridgeRulesStore.setState({
      loaded: true,
      rules: [
        { id: "r1", environmentId: "env_box", hostName: "box", sessionId: "s1", threadTitle: "iOS", kind: "program", program: "xcodebuild", uses: 2 },
        { id: "r2", environmentId: "env_box", hostName: "box", sessionId: "s1", threadTitle: "iOS", kind: "read-folder", folder: "/Users/me/app" },
      ] as MacBridgeRule[],
    });
    render(<MacBridgeRuleList sessionId="s1" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Remove", "Remove", "Forget all"]);
    for (const b of buttons) {
      expect(b.dataset.variant).toBe("ghost");
      expect(b.className).toContain("text-muted-foreground");
      expect(b.className).toContain("hover:text-destructive");
    }
  });

  it("says its empty line on the page's inset", () => {
    render(<MacBridgeRuleList sessionId="s1" empty="Nothing remembered" />);
    expect(screen.getByText("Nothing remembered").dataset.slot).toBe("page-empty");
  });
});
