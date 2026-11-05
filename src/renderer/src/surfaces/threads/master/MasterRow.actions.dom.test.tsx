import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A board row's Pause, Resume and Start now say a refusal, never swallow it. */

const h = vi.hoisted(() => ({ actionFailed: vi.fn(), pause: vi.fn(), resume: vi.fn(), startNow: vi.fn() }));
vi.mock("../../../lib/threadActionToast", () => ({ actionFailed: h.actionFailed }));
vi.mock("../../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tcserver/commands")>()),
  pause: h.pause,
  resume: h.resume,
  startNow: h.startNow,
}));

import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink } from "../../../test/fakeMetaLink";
import { MasterRow } from "./MasterRow";
import { standInMeta, type BoardRowRef } from "./useMasterModel";

const menu = { rowsFor: () => null, onPick: () => {}, onOpenChange: () => {} };
const ref = (fallback: BoardRowRef["fallback"]): BoardRowRef => ({
  key: fallback!.id,
  id: fallback!.id,
  planId: null,
  group: "running",
  done: false,
  environmentId: fallback!.environmentId,
  fallback,
  override: null,
});

describe("a board row's state verb", () => {
  beforeEach(async () => {
    sessionStore.reset();
    sessionStore.attach(new FakeMetaLink());
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
    vi.clearAllMocks();
  });

  for (const [status, label, verb, command] of [
    ["running", "Pause", "pause it", "pause"],
    ["paused", "Resume", "resume it", "resume"],
    ["queued", "Start now", "start it now", "startNow"],
  ] as const) {
    it(`a refused ${label} toasts "Couldn't ${verb}" with the thread and the host's reason`, async () => {
      const refusal = new Error("this thread is moving to another host");
      h[command].mockRejectedValueOnce(refusal);
      const meta = standInMeta({ sessionId: "c1", environmentId: "local", title: "Home screen", status, provider: "claude", model: "claude-opus-5-5" }, "m");
      render(<MasterRow rowRef={ref(meta)} landed={false} host={null} onOpen={() => {}} menu={menu} />);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(h.actionFailed).toHaveBeenCalledWith(verb, "Home screen", refusal));
    });
  }
});
