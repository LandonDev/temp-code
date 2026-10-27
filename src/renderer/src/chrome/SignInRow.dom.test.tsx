// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAccounts, type AccountsSnapshot } from "@server/shared/accounts";
import type { ProfileView } from "aliax-core/shared/types";
import { accountsStore } from "../stores/accounts";
import { SignInRow, signInTarget } from "./SignInRow";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const { toast } = await import("sonner");

const withProfile = (provider: "claude" | "codex"): AccountsSnapshot => {
  const snapshot = emptyAccounts();
  snapshot.providers[provider].profiles = [{ name: "me@example.com" } as ProfileView];
  return snapshot;
};

describe("signInTarget", () => {
  const base = { canSignIn: true, loaded: true, snapshot: emptyAccounts(), harness: "claude" };

  it("is null before the snapshot loads, without a desktop window, or with any routed account", () => {
    expect(signInTarget({ ...base, loaded: false })).toBeNull();
    expect(signInTarget({ ...base, canSignIn: false })).toBeNull();
    expect(signInTarget({ ...base, snapshot: withProfile("claude") })).toBeNull();
    expect(signInTarget({ ...base, snapshot: withProfile("codex") })).toBeNull();
  });

  it("names the default harness's provider when it is routed, else Claude", () => {
    expect(signInTarget(base)).toBe("claude");
    expect(signInTarget({ ...base, harness: "codex" })).toBe("codex");
    expect(signInTarget({ ...base, harness: "cursor" })).toBe("claude");
  });
});

describe("SignInRow", () => {
  let finish: (result: { ok: boolean; error?: string }) => void = () => {};
  const loginStart = vi.fn(
    () => new Promise<{ ok: boolean; error?: string }>((resolve) => (finish = resolve)),
  );
  let refresh: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (window as unknown as { aliax: unknown }).aliax = { loginStart };
    refresh = vi.spyOn(accountsStore, "refresh").mockResolvedValue();
  });
  afterEach(() => {
    cleanup();
    loginStart.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.restoreAllMocks();
    delete (window as unknown as { aliax?: unknown }).aliax;
  });

  const row = () => screen.getByRole("button");

  it("is named for the account and starts Claude's sign-in once, then says Signing in…", async () => {
    render(<SignInRow provider="claude" />);
    expect(row().textContent).toBe("Sign in to Claude");
    fireEvent.click(row());
    expect(loginStart).toHaveBeenCalledWith("claude-code");
    expect(row().textContent).toBe("Signing in…");
    expect(row().closest("[data-rail-row]")?.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(row());
    expect(loginStart).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(refresh).toHaveBeenCalledWith(expect.any(String), "claude");
    expect(toast.error).not.toHaveBeenCalled();
    expect(row().textContent).toBe("Sign in to Claude");
  });

  it("toasts a failure with its line", async () => {
    render(<SignInRow provider="claude" />);
    fireEvent.click(row());
    await act(async () => finish({ ok: false, error: "claude.ai did not answer" }));
    expect(toast.error).toHaveBeenCalledWith("claude.ai did not answer");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says nothing when the window was closed", async () => {
    render(<SignInRow provider="claude" />);
    fireEvent.click(row());
    await act(async () => finish({ ok: false, error: "cancelled" }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
