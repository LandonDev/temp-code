import { vi } from "vitest";

type Child = typeof import("./child");

/**
 * Test helper: overlay a partial fake on the child bridge before the
 * engine under test is imported (every suite imports it dynamically after
 * this call). vitest keeps a module registry per test file, so nothing
 * leaks between suites and nothing needs putting back.
 */
export function mockChild(overrides: Partial<Child>): void {
  vi.doMock("./child", async () => ({
    ...(await vi.importActual<Child>("./child")),
    ...overrides,
  }));
}
