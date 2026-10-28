// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { fallbackFailure } from "@server/shared/failureFallback";
import { emptyThread } from "../lib/tcserver/todos";
import { errorRowOf } from "../lib/turnOutcome";
import { mountProbe } from "../test/renderProbe";

const continueSession = vi.fn<(id: string) => Promise<void>>();
vi.mock("../lib/tcserver/commands", () => ({
  continueSession: (id: string) => continueSession(id),
  rerouteSession: () => Promise.resolve({ account: null, moved: false }),
}));

import { ErrorChip } from "./ErrorChip";

const RAW = "turn ended: error_during_execution";
const rowOf = (text: string, stopped = false) => {
  const block = { id: "err:1", role: "system" as const, text, ...(stopped ? { stopped } : {}) };
  return errorRowOf({ blocks: [block], status: "error", thread: emptyThread() }, block);
};

describe("ErrorChip", () => {
  it("a stop is one Stopped line in the stopped state, with no button", () => {
    const probe = mountProbe(<ErrorChip sessionId="s1" row={rowOf("Stopped", true)} />);
    expect(probe.container.textContent).toBe("Stopped");
    expect(probe.container.querySelector('[data-state="stopped"]')).not.toBeNull();
    expect(probe.container.querySelector("button")).toBeNull();
    probe.unmount();
  });

  it("a failure the host never classified is the card with the fallback lines and Retry alone", async () => {
    continueSession.mockReset();
    continueSession.mockReturnValue(new Promise(() => {}));
    const probe = mountProbe(<ErrorChip sessionId="s1" row={rowOf(RAW)} />);
    const root = probe.container;
    const fallback = fallbackFailure();
    expect(root.querySelector("[data-failure-kind=unknown]")).not.toBeNull();
    expect(root.textContent).toContain(fallback.summary);
    expect(root.textContent).toContain(fallback.cause);
    expect(root.textContent).not.toContain(RAW);
    expect(root.textContent).not.toContain("error_during_execution");
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry"]);
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(continueSession).toHaveBeenCalledWith("s1");
    expect(root.querySelector("button")?.textContent).toBe("Retrying…");
    probe.unmount();
  });
});
