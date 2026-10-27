// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedEnvironment } from "@server/shared/contract-remote";

/**
 * The host dialogs on the dialog recipe: the capability toggles and the caps
 * a bot never holds, a secret's copy button, routes moving with the last one
 * held, Rename off until the name changes, Pair's two steps, and the fields
 * the environments e2e drives by `data-environment-field`.
 */

const calls: { method: string; params: unknown }[] = [];
const answers = new Map<string, unknown>();
vi.mock("../rpc", () => ({
  rpc: async (method: string, params: unknown) => {
    calls.push({ method, params });
    return answers.get(method);
  },
}));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA==" } }));

const { tooltipChunk, warmTooltips } = await import("@renderer/components/ui/tooltip");
const { NewKeyDialog } = await import("./NewKeyDialog");
const { PairDialog } = await import("./PairDialog");
const { RoutesDialog } = await import("./RoutesDialog");
const { RenameHostDialog } = await import("./RenameHostDialog");
const { AddHostDialog } = await import("./AddHostDialog");

// Tooltips load their primitive on the first hover; load it once up front.
beforeAll(async () => {
  await tooltipChunk.load();
  warmTooltips();
});

const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  calls.length = 0;
  answers.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const env = (over: Partial<SavedEnvironment> = {}): SavedEnvironment =>
  ({
    id: "env_box",
    name: "box",
    routes: [
      { url: "wss://tempcode.example.com/ws", kind: "tunnel" },
      { url: "ws://10.0.0.5:7677/ws", kind: "lan" },
    ],
    ...over,
  }) as SavedEnvironment;

const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const noop = async () => undefined;

describe("NewKeyDialog", () => {
  it("toggles caps, holds a bot to operate, and shows the key once with its copy", async () => {
    const onClose = vi.fn();
    render(<NewKeyDialog onClose={onClose} onChanged={noop} />);
    expect(pressed("Operate")).toBe("true");
    expect(pressed("Approve")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(pressed("Approve")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Bot (MCP)" }));
    expect(pressed("Bot (MCP)")).toBe("true");
    expect(pressed("Approve")).toBe("false");
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Admin" }).hasAttribute("disabled")).toBe(true);
    expect(pressed("Operate")).toBe("true");
    // The reason rides the disabled toggle's wrapper, which still takes the pointer.
    const wrapper = screen.getByRole("button", { name: "Admin" }).parentElement!;
    fireEvent.pointerEnter(wrapper, { pointerType: "mouse" });
    fireEvent.mouseEnter(wrapper);
    fireEvent.mouseMove(wrapper);
    fireEvent.pointerMove(wrapper, { pointerType: "mouse" });
    expect(await screen.findByText("Bots never approve or administer", {}, { timeout: 2000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "grok" } });
    answers.set("remote.keys.create", { key: { id: "k1" }, token: "tc_k1.secret" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(calls[0]).toEqual({ method: "remote.keys.create", params: { name: "grok", audience: "mcp", caps: ["operate"] } });

    expect(await screen.findByText("Key created")).toBeTruthy();
    expect(screen.getByText("Copy it now. It is not shown again.")).toBeTruthy();
    const key = screen.getByLabelText("Key") as HTMLInputElement;
    expect(key.value).toBe("tc_k1.secret");
    expect(key.readOnly).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    });
    expect(writeText).toHaveBeenCalledWith("tc_k1.secret");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("RoutesDialog", () => {
  it("moves a route, holds the last one, and saves the order", async () => {
    const onClose = vi.fn();
    render(<RoutesDialog env={env()} onClose={onClose} onChanged={noop} />);
    const origins = () => within(screen.getByRole("list", { name: "Routes" })).getAllByRole("listitem").map((row) => row.textContent);
    expect(origins()[0]).toContain("tempcode.example.com");

    const [firstDown] = screen.getAllByRole("button", { name: "Move down" });
    fireEvent.click(firstDown);
    expect(origins()[0]).toContain("10.0.0.5:7677");
    expect(screen.getAllByRole("button", { name: "Move up" })[0].hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove route" })[1]);
    expect(origins()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove route" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls[0]).toEqual({ method: "remote.environments.update", params: { id: "env_box", routes: [{ url: "ws://10.0.0.5:7677/ws", kind: "lan" }] } });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("RenameHostDialog", () => {
  it("is off until the name changes, then renames and closes once", async () => {
    const onClose = vi.fn();
    render(<RenameHostDialog env={env()} onClose={onClose} onChanged={noop} />);
    const field = screen.getByLabelText("Name");
    expect(field.getAttribute("data-environment-field")).toBe("rename");
    expect(document.activeElement).toBe(field);
    const rename = screen.getByRole("button", { name: "Rename" });
    expect(rename.hasAttribute("disabled")).toBe(true);
    fireEvent.change(field, { target: { value: "  box  " } });
    expect(rename.hasAttribute("disabled")).toBe(true);
    fireEvent.change(field, { target: { value: "studio" } });
    expect(rename.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(rename);
    });
    expect(calls).toEqual([{ method: "remote.environments.update", params: { id: "env_box", name: "studio" } }]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("PairDialog", () => {
  it("makes a code, then shows it with the caps and the countdown; Cancel takes it back", async () => {
    const onClose = vi.fn();
    render(<PairDialog onClose={onClose} onChanged={noop} />);
    expect(screen.getByRole("button", { name: "Create code" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "iPhone" } });
    answers.set("remote.pairings.create", {
      pairing: { id: "p1", caps: ["operate"], expiresAt: Date.now() + 9 * 60_000 + 41_000 },
      code: "ABCDE-12345",
      url: "https://box.example.com/pair#ABCDE-12345",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create code" }));
    });
    expect(calls[0]).toEqual({ method: "remote.pairings.create", params: { name: "iPhone", audience: "client", caps: ["operate"] } });

    expect(await screen.findByText("ABCDE-12345")).toBeTruthy();
    expect(screen.getByAltText("Pairing QR code")).toBeTruthy();
    expect(screen.getByText("Read, operate")).toBeTruthy();
    expect(screen.getByText(/expires in 9:4\d/)).toBeTruthy();
    expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe("https://box.example.com/pair#ABCDE-12345");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(writeText).toHaveBeenCalledWith("ABCDE-12345");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.method)).toContain("remote.pairings.revoke");
  });
});

describe("AddHostDialog", () => {
  it("keeps the e2e's fields and switches from a link to a host and key", () => {
    render(<AddHostDialog onClose={() => {}} onChanged={noop} />);
    const field = (name: string) => document.querySelector(`[data-environment-field="${name}"]`);
    expect(field("link")).toBe(screen.getByLabelText("Pairing link"));
    expect(field("name")).toBe(screen.getByLabelText("Name"));
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Key" }));
    expect(field("link")).toBeNull();
    expect(field("origin")).toBe(screen.getByLabelText("Host"));
    expect(field("key")).toBe(screen.getByLabelText("Key"));
    expect(pressed("Key")).toBe("true");
    // A pressed choice stays pressed: one of the two is always the mode.
    fireEvent.click(screen.getByRole("button", { name: "Key" }));
    expect(pressed("Key")).toBe("true");
  });
});
