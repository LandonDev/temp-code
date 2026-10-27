// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxListEmpty } from "./InboxView";

/** The inbox list with nothing to show: one title and one line per case,
 *  and Clear filters only when the person narrowed it. */

afterEach(cleanup);

const view = (props: Partial<Parameters<typeof InboxListEmpty>[0]> = {}) =>
  render(<InboxListEmpty narrowed={false} source="github" githubWorkspaces={2} onClearFilters={vi.fn()} {...props} />);

describe("InboxListEmpty", () => {
  it("narrowed: says the filters are narrowing it and clears them", () => {
    const onClearFilters = vi.fn();
    const { getByText, getByRole } = view({ narrowed: true, onClearFilters });
    expect(getByText("No matching issues")).toBeTruthy();
    expect(getByText("Filters are narrowing this list")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("Linear: names where the issues come from, with no button", () => {
    const { getByText, queryByRole } = view({ source: "linear" });
    expect(getByText("No Linear issues")).toBeTruthy();
    expect(getByText("Open issues from your Linear teams show here.")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
  });

  it("GitHub with no workspaces: says how to add one", () => {
    const { getByText } = view({ githubWorkspaces: 0 });
    expect(getByText("No GitHub workspaces")).toBeTruthy();
    expect(getByText("Add a GitHub repository as a workspace.")).toBeTruthy();
  });

  it("GitHub: names where issues and pull requests come from", () => {
    const { getByText, queryByRole } = view();
    expect(getByText("No issues or pull requests")).toBeTruthy();
    expect(getByText("Open issues and pull requests from your GitHub workspaces show here.")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
  });
});
