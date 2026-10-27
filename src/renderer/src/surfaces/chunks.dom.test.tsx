import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { allChunks, releaseNotesChunk } from "./chunks";
import { defineChunk } from "../lib/lazyChunk";
import { BUNDLED_RELEASE } from "../lib/releaseNotes";
import { SurfaceSkeleton } from "./SurfaceSkeleton";

/** What each chunk's barrel must expose: the mount points ask for these by name. */
const EXPECTED: Record<keyof typeof allChunks, string[]> = {
  settingsChunk: ["SettingsView"],
  aliaxChunk: ["AliaxPagesView"],
  diffChunk: ["DiffBody"],
  editorChunk: ["FileEditor", "handleEditorFindKey", "openFindInActiveEditor"],
  terminalChunk: ["TerminalView", "DevServersPane"],
  threadViewsChunk: ["ImplementationView", "OrchestrationView", "PlanView", "ResearchView"],
  htmlRenderChunk: ["HtmlRenderRow", "HtmlRenderDocument", "HtmlRenderViewer"],
  mediaChunk: ["MediaGate", "MediaReview"],
  lightboxChunk: ["Lightbox"],
  releaseNotesChunk: ["ReleaseNotesSurface"],
  rightPanelChunk: ["RightPanel"],
  searchChunk: ["SearchView"],
  inboxChunk: ["InboxView", "InboxDetailPane"],
  notesChunk: ["NotesView", "focusNote"],
  selectChunk: ["ChoiceSelect"],
};

describe("surfaces/chunks", () => {
  for (const [name, exported] of Object.entries(EXPECTED) as [keyof typeof allChunks, string[]][]) {
    it(`${name} loads and exposes ${exported.join(", ")}`, async () => {
      const mod = (await allChunks[name].load()) as Record<string, unknown>;
      // A plain component is a function; a memo() one is an object with $$typeof.
      for (const key of exported) expect(["function", "object"], key).toContain(typeof mod[key]);
      for (const key of exported) expect(mod[key], key).not.toBeNull();
    }, 60_000);
  }

  it("a cold surface renders its skeleton, then the notes; a warm one the notes at once", async () => {
    // A chunk of its own over the same module: nothing cached yet, so the
    // first mount suspends on the import even though vitest has the module.
    const cold = defineChunk("releaseNotes-cold", () => import("./ReleaseNotesSurface"));
    const Notes = cold.surface("ReleaseNotesSurface", <SurfaceSkeleton kind="pane" label="Loading release notes" />);
    const source = { version: BUNDLED_RELEASE.version };
    const { container } = render(<Notes source={source} />);
    expect(container.querySelector("[data-surface-skeleton='pane']")).not.toBeNull();
    await act(async () => {
      await cold.load();
    });
    await act(async () => {});
    expect(container.querySelector("[data-surface-skeleton]")).toBeNull();
    expect(container.textContent).toContain(BUNDLED_RELEASE.version);

    // The registry's chunk was loaded above: its surface mounts in one pass.
    const Warm = releaseNotesChunk.surface("ReleaseNotesSurface", <SurfaceSkeleton kind="pane" />);
    const warm = render(<Warm source={source} />);
    expect(warm.container.querySelector("[data-surface-skeleton]")).toBeNull();
    expect(warm.container.textContent).toContain(BUNDLED_RELEASE.version);
  });
});
