import { describe, expect, it } from "vitest";
import { messageClipboardHtml, parseCopiedMessage } from "./copyMessage";

describe("copied messages", () => {
  const msg = {
    text: "look at <this> & @thread:abcdef12",
    attachments: [{ id: "a", name: "shot.png", mimeType: "image/png", kind: "image" as const, size: 3 }],
  };
  it("round-trips text and attachments through the html flavour", () => {
    const html = messageClipboardHtml(msg);
    expect(html).toContain("look at &lt;this&gt; &amp; @thread:abcdef12");
    expect(parseCopiedMessage(html)).toEqual(msg);
  });
  it("ignores html without a payload or with a broken one", () => {
    expect(parseCopiedMessage("<b>x</b>")).toBeNull();
    expect(parseCopiedMessage('<div data-temp-code-message="%7B">x</div>')).toBeNull();
  });
});
