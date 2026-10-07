import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { htmlRenderOf } from "./htmlRenderBlock";

const reference = { sessionId: "s1", pageId: "p1234567890abcde", title: "Chart", height: 420 };
const result = { htmlRender: reference, message: "Shown above your reply." };

const call = (name: string, detail: string | undefined, status = "completed"): Block => ({
  id: "b1",
  role: "tool",
  text: name,
  tool: { callId: "c1", name, status, detail, input: { html: "<p/>", title: "Chart", height: 420 } },
});

describe("htmlRenderOf", () => {
  it("reads the reference from each harness's envelope", () => {
    expect(htmlRenderOf(call("mcp__app__html_render", JSON.stringify(result)))).toEqual(reference);
    expect(
      htmlRenderOf(
        call(
          "app.html_render",
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }, null, 2),
        ),
      ),
    ).toEqual(reference);
    expect(
      htmlRenderOf(call("app.html_render", JSON.stringify({ structuredContent: result, content: [] }))),
    ).toEqual(reference);
  });

  it("ignores other tools, running or failed calls, and malformed results", () => {
    expect(htmlRenderOf(call("mcp__app__html_preview", JSON.stringify(result)))).toBeNull();
    expect(htmlRenderOf(call("mcp__app__html_render", JSON.stringify(result), "running"))).toBeNull();
    expect(htmlRenderOf(call("mcp__app__html_render", JSON.stringify(result), "failed"))).toBeNull();
    expect(htmlRenderOf(call("mcp__app__html_render", "These local images could not be read"))).toBeNull();
    expect(htmlRenderOf(call("mcp__app__html_render", undefined))).toBeNull();
    expect(htmlRenderOf(call("mcp__app__html_render", JSON.stringify({ htmlRender: { pageId: 1 } })))).toBeNull();
    expect(htmlRenderOf({ id: "u", role: "user", text: JSON.stringify(result) })).toBeNull();
  });

  it("returns the same object for the same block", () => {
    const block = call("mcp__app__html_render", JSON.stringify(result));
    expect(htmlRenderOf(block)).toBe(htmlRenderOf(block));
    expect(htmlRenderOf({ ...block })).not.toBe(htmlRenderOf(block));
  });
});
