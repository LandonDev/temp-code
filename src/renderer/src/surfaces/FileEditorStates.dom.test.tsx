import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EditorLoading, EditorOpenError } from "./FileEditor";

describe("the editor's waiting states", () => {
  afterEach(cleanup);

  it("loads as eight bars shaped like code under the header's slot", () => {
    const { container } = render(<EditorLoading name="App.tsx" />);
    const bars = container.querySelectorAll('[data-slot="skeleton"]');
    expect(bars).toHaveLength(8);
    expect([...bars].map((bar) => (bar as HTMLElement).style.width)).toEqual(["60%", "82%", "45%", "70%", "90%", "38%", "66%", "52%"]);
    expect(container.querySelector(".h-8")).not.toBeNull();
    expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Opening App.tsx");
    expect(container.textContent).toBe("");
  });

  it("fails as one Empty: the name, why, and Retry", () => {
    const onRetry = vi.fn();
    const { container, getByRole } = render(
      <EditorOpenError name="App.tsx" line="No such file on box." onRetry={onRetry} />,
    );
    expect(container.querySelector('[data-slot="empty-title"]')!.textContent).toBe("Couldn’t open App.tsx");
    expect(container.querySelector('[data-slot="empty-description"]')!.textContent).toBe("No such file on box.");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
