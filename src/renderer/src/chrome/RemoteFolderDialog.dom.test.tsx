import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../lib/fs";

const fs = vi.hoisted(() => ({
  root: { root: "/srv/agents/work", home: "/srv/agents", hostname: "box", platform: "linux", exists: true },
  tree: {} as Record<string, string[]>,
  pending: null as null | Promise<void>,
  slow: {} as Record<string, Promise<void>>,
  created: [] as string[],
}));

vi.mock("../lib/connection", () => ({
  registry: { linkOf: () => ({ request: () => Promise.resolve(fs.root) }) },
  useEnvironments: () => [{ id: "box", name: "The box" }],
}));

vi.mock("../lib/fs", () => ({
  listDir: async (_env: string, path: string): Promise<FsEntry[]> => {
    if (fs.pending) await fs.pending;
    if (fs.slow[path]) await fs.slow[path];
    return (fs.tree[path] ?? []).map((name) => ({ name, path: `${path}/${name}`, isDir: true }) as FsEntry);
  },
  createPath: async (_env: string, parent: string, name: string) => {
    fs.created.push(`${parent}/${name}`);
    return `${parent}/${name}`;
  },
}));

import { RemoteFolderDialog } from "./RemoteFolderDialog";

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe("RemoteFolderDialog", () => {
  beforeEach(() => {
    fs.tree = { "/srv/agents/work": ["temp-code", "cosmic", ".hidden"], "/srv/agents/work/temp-code": [] };
    fs.pending = null;
    fs.slow = {};
    fs.created = [];
  });
  afterEach(cleanup);

  it("shows the list's shape while it loads, then the folders without hidden ones, and walks into one", async () => {
    let release = () => {};
    fs.pending = new Promise<void>((r) => (release = r));
    render(<RemoteFolderDialog environmentId="box" onClose={() => {}} onPick={() => {}} />);
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Add a workspace on The box" });
    const frame = dialog.querySelector("[data-remote-folders]")!;
    expect(frame.querySelectorAll("[data-slot=skeleton]")).toHaveLength(6);
    await act(async () => {
      release();
      fs.pending = null;
    });
    await flush();
    expect(within(frame as HTMLElement).getAllByRole("button").map((r) => r.textContent)).toEqual(["temp-code", "cosmic"]);
    expect(within(dialog).getByRole("button", { name: "work" }).getAttribute("aria-current")).toBe("location");

    fireEvent.click(within(frame as HTMLElement).getByRole("button", { name: "temp-code" }));
    await flush();
    expect(within(dialog).getByText("No folders")).toBeTruthy();
    expect((within(dialog).getByLabelText("Folder path") as HTMLInputElement).value).toBe("/srv/agents/work/temp-code");
    expect(within(dialog).getByRole("button", { name: "temp-code" }).getAttribute("aria-current")).toBe("location");
  });

  it("a slow listing for a folder already left never lands over the newer one", async () => {
    fs.tree["/srv/agents/work/cosmic"] = ["plugins"];
    let release = () => {};
    fs.slow["/srv/agents/work/temp-code"] = new Promise<void>((r) => (release = r));
    render(<RemoteFolderDialog environmentId="box" onClose={() => {}} onPick={() => {}} />);
    await flush();
    const frame = screen.getByRole("dialog").querySelector("[data-remote-folders]") as HTMLElement;
    fireEvent.click(within(frame).getByRole("button", { name: "temp-code" }));
    const path = screen.getByLabelText("Folder path");
    fireEvent.change(path, { target: { value: "/srv/agents/work/cosmic" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await flush();
    await act(async () => release());
    await flush();
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/srv/agents/work/cosmic");
    expect(within(frame).getAllByRole("button").map((b) => b.textContent)).toEqual(["plugins"]);
  });

  it("Use this folder picks the typed path once the exit has played", async () => {
    const onPick = vi.fn();
    render(<RemoteFolderDialog environmentId="box" onClose={() => {}} onPick={onPick} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/srv/agents/work"));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("New folder takes focus, Escape in it puts the path back without closing, and Create and use makes and picks it", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<RemoteFolderDialog environmentId="box" onClose={onClose} onPick={onPick} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const name = screen.getByLabelText("New folder name");
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Escape" });
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Folder path")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect((screen.getByRole("button", { name: "Create and use" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "scratch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and use" }));
    await flush();
    expect(fs.created).toEqual(["/srv/agents/work/scratch"]);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/srv/agents/work/scratch"));
  });
});
