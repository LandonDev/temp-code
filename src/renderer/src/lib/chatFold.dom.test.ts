// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetChatFolds, useChatFold } from "./chatFold";

afterEach(resetChatFolds);

describe("useChatFold", () => {
  it("remembers a fold per thread across an unmount, and says it remembered", () => {
    const first = renderHook(() => useChatFold("t1", true));
    expect(first.result.current[2]).toBe(false);
    act(() => first.result.current[1](false));
    first.unmount();
    const again = renderHook(() => useChatFold("t1", true));
    expect(again.result.current[0]).toBe(false);
    expect(again.result.current[2]).toBe(true);
    expect(renderHook(() => useChatFold("t2", true)).result.current[0]).toBe(true);
  });

  it("a question waiting at mount opens a remembered fold: the answer lives in the chat", () => {
    const first = renderHook(() => useChatFold("m", true));
    act(() => first.result.current[1](false));
    first.unmount();
    expect(renderHook(() => useChatFold("m", true, true)).result.current[0]).toBe(true);
  });
});
