// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewSettings } from "@server/shared/review";

const state = vi.hoisted(() => ({
  get: null as null | ((params: unknown) => Promise<unknown>),
  set: vi.fn(async (_params: unknown): Promise<unknown> => ({})),
}));

vi.mock("../lib/connection", () => ({
  registry: {
    primary: () => ({ environmentId: "local" }),
    linkOf: () => ({
      request: (method: string, params: unknown) => (method === "review.get" ? state.get!(params) : state.set(params)),
    }),
  },
}));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: undefined, catalog: null }) }));
vi.mock("../lib/models", () => ({ resolveModel: (harness: string) => ({ harness, id: "m", settings: [] }) }));
vi.mock("../lib/tcserver/defaults", async (original) => ({
  ...(await original<typeof import("../lib/tcserver/defaults")>()),
  effortLadder: () => [],
}));
vi.mock("../lib/reviewScope", async (original) => ({
  ...(await original<typeof import("../lib/reviewScope")>()),
  reviewerModel: () => null,
  reviewerModelOptions: () => [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }],
}));

const { ReviewsPage } = await import("./ReviewSettings");
const { ReviewFields } = await import("../chrome/ReviewFields");

const SETTINGS: ReviewSettings = {
  beforeMerge: false,
  provider: "codex",
  model: "gpt-6.1-sol",
  reasoning: "high",
  blockOn: "confirmed",
  maxMinutes: 15,
};

function answer(settings: ReviewSettings) {
  state.get = async () => ({ override: null, global: settings, settings, source: "global" });
}

const lastSet = () => (state.set.mock.calls.at(-1)?.[0] as { settings: ReviewSettings }).settings;

async function renderPage() {
  render(<ReviewsPage />);
  await act(async () => {});
}

beforeEach(() => {
  answer(SETTINGS);
  state.set.mockReset();
  state.set.mockImplementation(async () => ({}));
});
afterEach(cleanup);

describe("Reviews page", () => {
  it("shows skeleton rows before review.get answers", () => {
    state.get = () => new Promise(() => {});
    render(<ReviewsPage />);
    expect(screen.getByTestId("review-skeleton")).toBeTruthy();
  });

  it("shows one row while off and four while on", async () => {
    await renderPage();
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(1);
    cleanup();
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(4);
  });

  it("turns review on through review.set", async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Review before merge" }));
    });
    expect(lastSet().beforeMerge).toBe(true);
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(4);
  });

  it("saves Hold the merge on", async () => {
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Hold the merge on" }));
    });
    const option = await screen.findByRole("option", { name: "Any finding" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(lastSet().blockOn).toBe("any");
  });

  it("commits the time limit on Enter and reverts what is out of range", async () => {
    answer({ ...SETTINGS, beforeMerge: true });
    await renderPage();
    const field = screen.getByRole("textbox", { name: "Time limit" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "30" } });
    await act(async () => {
      field.focus();
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastSet().maxMinutes).toBe(30);
    for (const bad of ["0", "999"]) {
      state.set.mockClear();
      fireEvent.change(field, { target: { value: bad } });
      await act(async () => {
        fireEvent.blur(field);
      });
      expect(state.set).not.toHaveBeenCalled();
      expect(field.value).toBe("30");
    }
  });

  it("shows a failed save under the rows", async () => {
    state.set.mockImplementation(async () => {
      throw new Error("review.set refused");
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Review before merge" }));
    });
    expect(screen.getByText("review.set refused").className).toContain("text-destructive");
  });
});

describe("ReviewFields compact", () => {
  it("hides the three rows while review is off", () => {
    const { rerender } = render(<ReviewFields value={SETTINGS} onChange={() => {}} environmentId="local" compact />);
    expect(screen.queryByRole("combobox", { name: "Hold the merge on" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Time limit" })).toBeNull();
    rerender(<ReviewFields value={{ ...SETTINGS, beforeMerge: true }} onChange={() => {}} environmentId="local" compact />);
    expect(screen.getByRole("combobox", { name: "Hold the merge on" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Time limit" })).toBeTruthy();
  });
});
