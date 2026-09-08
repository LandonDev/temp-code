import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageQueue } from "./MessageQueue";

const noop = () => {};
const props = { onSteer: noop, onRemove: noop, onUpdate: noop, onReorder: noop };

describe("MessageQueue", () => {
  it("renders nothing when empty", () => {
    expect(renderToStaticMarkup(createElement(MessageQueue, { ...props, items: [] }))).toBe("");
  });

  it("numbers the rows under a count header, with steer and remove on each", () => {
    const html = renderToStaticMarkup(
      createElement(MessageQueue, {
        ...props,
        items: [
          { id: "a", text: "first", ts: 1 },
          { id: "b", text: "second", ts: 2 },
        ],
      }),
    );
    expect(html).toContain("Queued · 2");
    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html.match(/aria-label="Send now"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Remove from queue"/g)).toHaveLength(2);
  });

  it("hides steer while paused", () => {
    const html = renderToStaticMarkup(
      createElement(MessageQueue, { ...props, paused: true, items: [{ id: "a", text: "x", ts: 1 }] }),
    );
    expect(html).not.toContain("Send now");
    expect(html).toContain("Remove from queue");
  });
});
