// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Page, PageRow, PageSection } from "./page";
import { Button } from "./ui/button";

afterEach(cleanup);

describe("Page", () => {
  it("has one page title and section headings under it", () => {
    render(
      <Page title="General" description="How the app behaves.">
        <PageSection title="Transcript">
          <PageRow title="Zen mode" />
        </PageSection>
      </Page>,
    );
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["General"]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Transcript");
    expect(screen.getByText("How the app behaves.")).toBeTruthy();
  });

  it("puts the actions on the title line", () => {
    render(
      <Page title="Accounts" actions={<Button>Add</Button>}>
        <PageSection>
          <PageRow title="One" />
        </PageSection>
      </Page>,
    );
    const header = screen.getByRole("heading", { level: 1 }).closest("header");
    expect(header?.contains(screen.getByRole("button", { name: "Add" }))).toBe(true);
  });
});

describe("PageSection", () => {
  it("is a region named by its heading, with its action beside it", () => {
    render(
      <PageSection title="Plans" action={<Button variant="ghost" size="sm">Reset</Button>}>
        <PageRow title="Auto start" />
      </PageSection>,
    );
    const region = screen.getByRole("region", { name: "Plans" });
    expect(region.contains(screen.getByRole("button", { name: "Reset" }))).toBe(true);
  });
});

describe("PageRow", () => {
  it("draws a hairline only between neighbouring rows", () => {
    render(
      <PageSection title="Extras">
        <PageRow title="Sounds" />
        <PageRow title="Games" />
        <PageRow title="Mascot" />
      </PageSection>,
    );
    const rows = [...document.querySelectorAll("[data-slot=page-row]")];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(rows[0].parentElement?.firstElementChild);
    for (const row of rows) {
      expect(row.className).toContain("border-t-transparent");
      expect(row.className).toContain("[[data-slot=page-row]+&]:border-t-border");
      expect(row.className).toContain("border-b-0");
    }
  });

  it("shows an error under the description, unclamped", () => {
    render(<PageRow title="Linear" description="Not connected" error="That key was refused." />);
    const error = screen.getByText("That key was refused.");
    expect(error.className).toContain("text-destructive");
    expect(error.className).toContain("line-clamp-none");
  });

  it("never clamps a description, so its later lines stay readable", () => {
    render(
      <PageRow
        title="Codex"
        description={
          <>
            <span className="block">codex-cli 0.162.1</span>
            <span className="block">/usr/bin/codex</span>
            <span className="block">Login expired</span>
          </>
        }
      />,
    );
    expect(screen.getByText("Login expired").closest("p")?.className).toContain("line-clamp-none");
  });
});
