// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import type { Failure, FailureKind } from "@server/shared/events";
import { mountProbe } from "../test/renderProbe";
import { failureActions, failureNote, SIGN_IN_ELSEWHERE_NOTE } from "../lib/failureActions";
import { OPEN_MODEL_PICKER } from "../lib/modelPickerSignal";

const continueSession = vi.fn<(id: string) => Promise<void>>();
const rerouteSession = vi.fn<(id: string) => Promise<{ account: string | null; moved: boolean }>>();
vi.mock("../lib/tcserver/commands", () => ({
  continueSession: (id: string) => continueSession(id),
  rerouteSession: (id: string) => rerouteSession(id),
}));

// The thread the card belongs to: null (a claude thread by default) unless a test names one.
let threadMeta: { provider: string; model: string; environmentId?: string } | null = null;
vi.mock("../lib/tcserver/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/store")>()),
  useSessionMeta: () => threadMeta,
}));

import { shell } from "../stores/shell";
import { FailureCard, FailureCardView, canSignInHere } from "./FailureCard";

const failure = (kind: FailureKind, over: Partial<Failure> = {}): Failure => ({
  kind,
  account: "me@example.com",
  summary: `${kind} summary`,
  cause: `${kind} cause`,
  ...over,
});

const KINDS: FailureKind[] = [
  "oauth_expired",
  "account_unknown",
  "key_invalid",
  "token_expired",
  "rate_limited",
  "quota",
  "model_unavailable",
  "network",
  "harness_crashed",
  "unknown",
];

const buttons = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll("button[data-failure-action]")).map((b) => b.textContent ?? "");

describe("FailureCardView per kind", () => {
  for (const kind of KINDS) {
    for (const signInHere of [true, false]) {
      it(`${kind} on ${signInHere ? "this Mac" : "the box"}: two lines, the right actions, Retry last`, () => {
        const ctx = { provider: "claude", signInHere };
        const f = failure(kind);
        const onAction = vi.fn();
        const probe = mountProbe(
          <FailureCardView
            failure={f}
            actions={failureActions(kind, ctx)}
            note={failureNote(kind, ctx)}
            state={{ pending: null, outcome: null }}
            onAction={onAction}
          />,
        );
        const root = probe.container;
        const card = root.querySelector("[role=alert]");
        expect(card?.getAttribute("data-failure-kind")).toBe(kind);
        const text = root.textContent ?? "";
        expect(text).toContain(f.summary);
        expect(text).toContain(f.cause);
        const labels = buttons(root);
        expect(labels.length).toBeLessThanOrEqual(3);
        expect(labels.at(-1)).toBe("Retry");
        expect(labels).toEqual(failureActions(kind, ctx).map((a) => a.label));
        for (const b of root.querySelectorAll("button[data-failure-action]")) {
          expect(b.getAttribute("data-slot")).toBe("button");
        }
        expect(root.querySelector("button[data-failure-action]")?.getAttribute("data-variant")).toBe("default");
        if (kind === "oauth_expired" && !signInHere) expect(text).toContain(SIGN_IN_ELSEWHERE_NOTE);
        else expect(text).not.toContain(SIGN_IN_ELSEWHERE_NOTE);
        fireEvent.click(root.querySelector("button[data-failure-action=retry]")!);
        expect(onAction).toHaveBeenCalledWith("retry");
        probe.unmount();
      });
    }
  }

  it("a pending action reads as its progress word and parks every button", () => {
    const ctx = { provider: "claude", signInHere: true };
    const probe = mountProbe(
      <FailureCardView
        failure={failure("oauth_expired")}
        actions={failureActions("oauth_expired", ctx)}
        note={null}
        state={{ pending: "route", outcome: null }}
        onAction={() => {}}
      />,
    );
    expect(buttons(probe.container)).toEqual(["Sign in", "Routing…", "Retry"]);
    for (const b of probe.container.querySelectorAll("button")) expect(b.disabled).toBe(true);
    probe.unmount();
  });

  it("an outcome line sits after the buttons", () => {
    const ctx = { provider: "claude", signInHere: true };
    const probe = mountProbe(
      <FailureCardView
        failure={failure("rate_limited")}
        actions={failureActions("rate_limited", ctx)}
        note={null}
        state={{ pending: null, outcome: "No other account has room right now." }}
        onAction={() => {}}
      />,
    );
    expect(probe.container.textContent).toContain("No other account has room right now.");
    probe.unmount();
  });
});

describe("FailureCard wired", () => {
  beforeEach(() => {
    continueSession.mockReset();
    rerouteSession.mockReset();
    continueSession.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete (window as { aliax?: unknown }).aliax;
    threadMeta = null;
    vi.restoreAllMocks();
  });

  it("a refused Meta key: its two lines, then Open accounts and Retry; Open accounts opens the Accounts page", () => {
    threadMeta = { provider: "claude", model: "muse-wonder-1.0" };
    const open = vi.spyOn(shell, "openAccountsPage").mockImplementation(() => {});
    const f = failure("key_invalid", {
      account: "Work",
      summary: "Meta refused the key Work",
      cause: "The key was revoked or deleted; make a new one at dev.meta.ai",
    });
    const probe = mountProbe(<FailureCard sessionId="s1" failure={f} />);
    const text = probe.container.textContent ?? "";
    expect(text).toContain("Meta refused the key Work");
    expect(text).toContain("make a new one at dev.meta.ai");
    expect(buttons(probe.container)).toEqual(["Open accounts", "Retry"]);
    fireEvent.click(probe.container.querySelector("button[data-failure-action=open-accounts]")!);
    expect(open).toHaveBeenCalledWith("accounts");
    probe.unmount();
  });

  it("a Meta thread with no key offers Add key…, under either harness, and it opens the Accounts page", () => {
    const open = vi.spyOn(shell, "openAccountsPage").mockImplementation(() => {});
    for (const provider of ["claude", "codex"]) {
      threadMeta = { provider, model: "muse-spark-1.3" };
      const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("account_unknown", { account: null })} />);
      expect(buttons(probe.container)).toEqual(["Add key…", "Retry"]);
      fireEvent.click(probe.container.querySelector("button[data-failure-action=add-key]")!);
      probe.unmount();
    }
    expect(open).toHaveBeenCalledTimes(2);
    // A Claude model's unknown account still routes.
    threadMeta = { provider: "claude", model: "claude-opus-5-5" };
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("account_unknown")} />);
    expect(buttons(probe.container)).toEqual(["Route automatically", "Pick another account", "Retry"]);
    probe.unmount();
  });

  it("Pick another account with no saved accounts says so instead of opening", () => {
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("account_unknown")} />);
    fireEvent.click(probe.container.querySelector("button[data-failure-action=pick-account]")!);
    expect(probe.container.textContent).toContain("No saved accounts on this host.");
    expect(document.querySelector("[data-account-picker]")).toBeNull();
    probe.unmount();
  });

  it("without the desktop bridge the sign-in is a note; Retry continues the thread", async () => {
    expect(canSignInHere("local")).toBe(false);
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("oauth_expired")} />);
    expect(probe.container.textContent).toContain(SIGN_IN_ELSEWHERE_NOTE);
    expect(buttons(probe.container)).toEqual(["Route automatically", "Pick another account", "Retry"]);
    await act(async () => {
      fireEvent.click(probe.container.querySelector("button[data-failure-action=retry]")!);
    });
    expect(continueSession).toHaveBeenCalledWith("s1");
    expect(buttons(probe.container)).toEqual(["Route automatically", "Pick another account", "Retrying…"]);
    probe.unmount();
  });

  it("Route automatically re-picks the account and continues when the thread moved", async () => {
    rerouteSession.mockResolvedValue({ account: "b@example.com", moved: true });
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("account_unknown")} />);
    await act(async () => {
      fireEvent.click(probe.container.querySelector("button[data-failure-action=route]")!);
    });
    expect(rerouteSession).toHaveBeenCalledWith("s1");
    expect(continueSession).toHaveBeenCalledWith("s1");
    expect(probe.container.textContent).toContain("Now on b@example.com");
    probe.unmount();
  });

  it("Route automatically with nowhere to go says so and leaves the thread alone", async () => {
    rerouteSession.mockResolvedValue({ account: "me@example.com", moved: false });
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("quota")} />);
    await act(async () => {
      fireEvent.click(probe.container.querySelector("button[data-failure-action=route]")!);
    });
    expect(continueSession).not.toHaveBeenCalled();
    expect(probe.container.textContent).toContain("No other account has room right now.");
    for (const b of probe.container.querySelectorAll("button")) expect(b.disabled).toBe(false);
    probe.unmount();
  });

  it("with the desktop bridge on this Mac, Sign in opens the Aliax sign-in for the account", async () => {
    const loginStart = vi.fn().mockResolvedValue({ ok: true });
    (window as { aliax?: unknown }).aliax = { loginStart };
    expect(canSignInHere("local")).toBe(true);
    expect(canSignInHere("env_box")).toBe(false);
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("oauth_expired")} />);
    expect(buttons(probe.container)).toEqual(["Sign in", "Route automatically", "Retry"]);
    expect(probe.container.textContent).not.toContain(SIGN_IN_ELSEWHERE_NOTE);
    await act(async () => {
      fireEvent.click(probe.container.querySelector("button[data-failure-action=sign-in]")!);
    });
    expect(loginStart).toHaveBeenCalledWith("claude-code", "me@example.com");
    expect(probe.container.textContent).toContain("Signed in. Retry to pick the work back up.");
    probe.unmount();
  });

  it("Pick another model asks the active composer's picker to open", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_MODEL_PICKER, heard);
    const probe = mountProbe(<FailureCard sessionId="s1" failure={failure("model_unavailable")} />);
    expect(buttons(probe.container)).toEqual(["Pick another model", "Retry"]);
    fireEvent.click(probe.container.querySelector("button[data-failure-action=pick-model]")!);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_MODEL_PICKER, heard);
    probe.unmount();
  });
});
