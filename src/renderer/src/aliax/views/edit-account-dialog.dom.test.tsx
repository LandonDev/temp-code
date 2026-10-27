// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_COLORS } from "@aliax/lib/accounts";
import { EditAccountDialog } from "./edit-account-dialog";

afterEach(cleanup);

describe("EditAccountDialog", () => {
  it("Save sends the nickname and the colour, then closes", async () => {
    const updateProfile = vi.fn(async () => ({ ok: true }));
    (window as unknown as { aliax: unknown }).aliax = { updateProfile };
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <EditAccountDialog
        open
        onOpenChange={onOpenChange}
        serviceId="codex"
        profile={{ name: "a@x.com", email: "a@x.com", createdAt: 1, active: false }}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByText("a@x.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: ACCOUNT_COLORS[2].id }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(updateProfile).toHaveBeenCalledWith("codex", "a@x.com", { nickname: "Work", color: ACCOUNT_COLORS[2].value });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalled();
  });
});
