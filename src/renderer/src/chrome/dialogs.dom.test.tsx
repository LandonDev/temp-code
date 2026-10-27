// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk } from "../lib/lazyChunk";
import { dialogsChunk } from "../surfaces/chunks";

vi.mock("../hooks/paneVisibility", () => ({ usePaneVisible: () => true }));

afterEach(cleanup);

describe("dialogsChunk", () => {
  it("a cold click opens the dialog once the chunk lands; a warm one opens it at once", async () => {
    // A chunk of its own over the same barrel: nothing cached, so the first
    // mount suspends on the import, and shows nothing until it lands.
    const cold = defineChunk("dialogs-cold", () => import("./dialogs"));
    const Cold = cold.surface("WhatsNewDialog");
    render(<Cold version="1.0.1" markdown="Fixed the thing." onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      await cold.load();
    });
    await act(async () => {});
    const opened = screen.getByRole("dialog", { name: "What's new" });
    expect(opened.textContent).toContain("Fixed the thing.");
    // Focus lands where Modal puts it, inside the dialog.
    await waitFor(() => expect(opened.contains(document.activeElement)).toBe(true));
    cleanup();

    // Hover warmed the registry's chunk: the dialog mounts in one pass.
    await act(async () => {
      dialogsChunk.intent.onPointerEnter();
      await dialogsChunk.load();
    });
    const Warm = dialogsChunk.surface("WhatsNewDialog");
    render(<Warm version="1.0.2" markdown="Another fix." onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "What's new" }).textContent).toContain("Another fix.");
  }, 60_000);
});
