// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Skill, SkillFile, SkillMeta } from "@shared/contract-skills";
import { expectModalShape } from "../../../chrome/modalShape.testkit";
import { fakeStoreHost } from "../storeHost.testkit";

vi.mock("../../../components/choice-select", async () => await import("../../../components/choice-select-body"));
// The editor chunk's surface as a textarea: CodeMirror is SkillTextEditor.test.tsx's.
vi.mock("../../chunks", async (original) => ({
  ...(await original<typeof import("../../chunks")>()),
  editorChunk: {
    surface: () =>
      function Editor(props: { path: string; value: string; label: string; onChange: (t: string) => void }) {
        return <textarea data-editor aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />;
      },
  },
}));

const { SkillDialog } = await import("./SkillDialog");
const { ConfirmHost } = await import("../../../chrome/ConfirmDialog");

afterEach(cleanup);

const MD = "---\nname: polish\ndescription: Polish the UI\n---\n\nBody\n";
const FILES: SkillFile[] = [
  { path: "scripts/run.sh", text: "#!/bin/sh\n", executable: true },
  { path: "SKILL.md", text: MD },
  { path: "assets/logo.png", base64: "iVBORw0KGgo=" },
];
const polish: Skill = {
  id: "sk_polish",
  name: "polish",
  workspaceId: null,
  description: "Polish the UI",
  harnesses: ["claude", "codex"],
  enabled: true,
  version: 3,
  digest: "d",
  bytes: 100,
  fileCount: 3,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 50,
  files: FILES,
};
const metaOf = ({ files: _files, ...meta }: Skill): SkillMeta => meta;

const flush = () => act(async () => {});
async function open(skill: SkillMeta | null, host = fakeStoreHost({ skills: [polish] })) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <>
      <SkillDialog link={host.link} skill={skill} workspaces={[{ id: "ws_1", name: "temp-code" }]} onClose={onClose} onSaved={onSaved} />
      <ConfirmHost />
    </>,
  );
  await flush();
  return { host, onSaved, onClose, dialog: screen.getByRole("dialog") };
}
const editor = () => document.querySelector<HTMLTextAreaElement>("[data-editor]")!;
const fileRows = (dialog: HTMLElement) => within(within(dialog).getByRole("navigation", { name: "Files" })).getAllByRole("button");
const escape = () => act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));

describe("SkillDialog", () => {
  it("has the one dialog shape around its own root", async () => {
    const { dialog } = await open(metaOf(polish));
    expectModalShape(dialog);
    expect(within(dialog).getByRole("heading").textContent).toBe("Edit polish");
  });

  it("lists SKILL.md first and opens it", async () => {
    const { dialog } = await open(metaOf(polish));
    expect(fileRows(dialog).map((b) => b.getAttribute("data-jump-key"))).toEqual(["SKILL.md", "assets/logo.png", "scripts/run.sh"]);
    expect(editor().value).toBe(MD);
  });

  it("lists a binary file with its size and shows one line in the editor's place", async () => {
    const { dialog } = await open(metaOf(polish));
    const logo = fileRows(dialog)[1]!;
    expect(logo.textContent).toContain("8 B");
    fireEvent.click(logo);
    expect(editor().closest("[data-editor-frame]")!.className).toContain("hidden");
    expect(dialog.querySelector("[data-binary-line]")!.textContent).toBe("Binary file, 8 B");
  });

  it("saves every file, the edit applied, with the updatedAt it read", async () => {
    const { host, dialog, onSaved } = await open(metaOf(polish));
    fireEvent.change(editor(), { target: { value: `${MD}More\n` } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    const [sent] = host.sent("skills.set") as { skill: { files: SkillFile[] }; expectUpdatedAt: number }[];
    expect(sent).toEqual({
      skill: { id: "sk_polish", name: "polish", workspaceId: null, harnesses: ["claude", "codex"], enabled: true, files: [FILES[0], { path: "SKILL.md", text: `${MD}More\n` }, FILES[2]] },
      expectUpdatedAt: 50,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "sk_polish", version: 4 }));
  });

  it("checks the files the host's way and sends nothing on a problem", async () => {
    const { host, dialog } = await open(metaOf(polish));
    fireEvent.change(editor(), { target: { value: MD.replace("name: polish", "name: other") } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(within(dialog).getByText("SKILL.md names the skill other, not polish")).toBeTruthy();
    expect(host.sent("skills.set")).toEqual([]);
  });

  it("puts the host's refusal on the red line", async () => {
    const host = fakeStoreHost({ skills: [polish] });
    const { dialog } = await open(metaOf(polish), host);
    // Another writer moved it after the dialog read it.
    host.state.skills = [{ ...polish, updatedAt: 99 }];
    fireEvent.change(editor(), { target: { value: `${MD}x` } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(within(dialog).getByText("Polish changed since it was read")).toBeTruthy();
  });

  it("refuses a skill that moved after the list read it, never writing the list's fields over the newer one", async () => {
    // The host holds a newer version (other CLIs, a later stamp) than the row the list showed.
    const host = fakeStoreHost({ skills: [{ ...polish, harnesses: "all", updatedAt: 60 }] });
    const { dialog, onSaved } = await open(metaOf(polish), host);
    fireEvent.change(editor(), { target: { value: `${MD}x` } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect((host.sent("skills.set")[0] as { expectUpdatedAt: number }).expectUpdatedAt).toBe(50);
    expect(within(dialog).getByText("Polish changed since it was read")).toBeTruthy();
    expect(host.state.skills[0]!.harnesses).toBe("all");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps the editor mounted while a binary file is shown, so its undo history stays", async () => {
    const { dialog } = await open(metaOf(polish));
    const before = editor();
    fireEvent.change(before, { target: { value: `${MD}edit` } });
    fireEvent.click(fileRows(dialog)[1]!);
    expect(editor()).toBe(before);
    expect(before.closest("[data-editor-frame]")!.className).toContain("hidden");
    fireEvent.click(fileRows(dialog)[0]!);
    expect(editor()).toBe(before);
    expect(before.closest("[data-editor-frame]")!.className).not.toContain("hidden");
    expect(before.value).toBe(`${MD}edit`);
  });

  it("starts a new skill from the template, its name line following the Name field, and creates it", async () => {
    const { host, dialog, onSaved } = await open(null);
    expect(within(dialog).getByRole("heading").textContent).toBe("New skill");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "tidy" } });
    expect(editor().value).toBe("---\nname: tidy\ndescription: \n---\n\n");
    fireEvent.change(editor(), { target: { value: "---\nname: tidy\ndescription: Tidy the code\n---\n" } });
    // A box can be unticked, never the last one ticked.
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Muse" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create" })));
    expect(host.sent("skills.set")).toEqual([
      {
        skill: { name: "tidy", workspaceId: null, harnesses: ["claude", "codex"], enabled: true, files: [{ path: "SKILL.md", text: "---\nname: tidy\ndescription: Tidy the code\n---\n" }] },
        expectUpdatedAt: 0,
      },
    ]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "tidy" }));
  });

  it("keeps the last CLI ticked", async () => {
    const { dialog } = await open(metaOf({ ...polish, harnesses: ["codex"] }));
    expect(within(dialog).getByRole("checkbox", { name: "Codex" }).hasAttribute("data-disabled")).toBe(true);
    expect(within(dialog).getByRole("checkbox", { name: "Claude" }).hasAttribute("data-disabled")).toBe(false);
  });

  it("asks before Escape drops edits: Cancel keeps the dialog, Discard closes it", async () => {
    const { dialog, onClose } = await open(metaOf(polish));
    fireEvent.change(editor(), { target: { value: "changed" } });
    await escape();
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Discard changes to polish?");
    // The confirm draws over the dialog and takes the focus.
    expect(dialog.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true));
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" })));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    const again = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Discard" })));
    await flush();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes at once on Escape when nothing changed", async () => {
    const { onClose } = await open(metaOf(polish));
    await escape();
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
