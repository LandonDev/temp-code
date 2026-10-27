// @vitest-environment jsdom
/**
 * The composer's bar: the send button speaks the intent Enter would carry
 * out and calls the matching handler.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SendButton } from "./ComposerBar";

afterEach(cleanup);

describe("SendButton", () => {
  it("names the intent and sends, queues or steers through onSubmit", () => {
    const onSubmit = vi.fn();
    const onPause = vi.fn();
    const { rerender } = render(<SendButton intent="send" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith(false);
    rerender(<SendButton intent="steer" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Steer" }), { metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith(true);
    expect(onPause).not.toHaveBeenCalled();
  });

  it("an empty box mid-turn is Pause", () => {
    const onSubmit = vi.fn();
    const onPause = vi.fn();
    render(<SendButton intent="pause" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disabled while there is nothing to send", () => {
    render(<SendButton intent="send" disabled onSubmit={() => {}} onPause={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });
});
