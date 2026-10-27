// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { loadToast } from "./toaster";

describe("loadToast", () => {
  it("answers sonner's toast, loading the module once", async () => {
    const first = loadToast();
    expect(loadToast()).toBe(first);
    expect(await first).toBe(toastMock);
  });
});
