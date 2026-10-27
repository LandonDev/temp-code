// @vitest-environment jsdom
/**
 * The orchestration thread (A18) is the chat under a header: no board, no
 * agent rows, no "Orchestrator log" edge tab. A spawn row in the transcript
 * still opens the agent's detail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import type { Session } from "../../lib/session";
import type { SessionMeta } from "../../lib/tcserver/types";

const h = vi.hoisted(() => ({ agents: [] as SessionMeta[], opened: [] as string[] }));

vi.mock("../../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threads/agents")>()),
  useAgents: () => h.agents,
}));
vi.mock("./fleet/AgentDetail", () => ({
  AgentDetail: ({ agentId }: { agentId: string }) => <div data-testid="agent-detail">{agentId}</div>,
}));

import { OpenAgentDetailContext } from "../agentDetailContext";
import { OrchestrationView } from "./OrchestrationView";
import type { ThreadViewProps } from "./ThreadView";
import { FLEET_METAS } from "./fleet/fleetFixture";

let openAgent: ((id: string) => void) | null = null;
function SpawnRow() {
  openAgent = useContext(OpenAgentDetailContext);
  return <div data-testid="transcript">transcript</div>;
}

const session = {
  id: "orch",
  cwd: "/repo",
  environmentId: "local",
  blocks: [{ id: "u1", role: "user", text: "Ship the iOS thread screens\nin parallel" }],
} as unknown as Session;

const props = (): ThreadViewProps =>
  ({
    session,
    composing: false,
    onArmNewPass: () => {},
    onOpenFile: () => {},
    onOpenDiff: () => {},
    renderChat: () => <SpawnRow />,
    renderSlots: () => ({ transcript: <SpawnRow />, strip: null, composer: <div data-testid="composer" /> }),
  }) as unknown as ThreadViewProps;

afterEach(() => {
  cleanup();
  h.agents = [];
  openAgent = null;
});

describe("OrchestrationView", () => {
  it("is the chat under the header, with no rows and no orchestrator log", () => {
    h.agents = FLEET_METAS;
    const { container, getByTestId, queryByText } = render(<OrchestrationView {...props()} />);
    const header = container.querySelector('[data-slot="fleet-header"]')!;
    expect(header.textContent).toContain("Ship the iOS thread screens");
    expect(header.compareDocumentPosition(getByTestId("transcript")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByTestId("composer")).toBeTruthy();
    expect(queryByText("Orchestrator log")).toBeNull();
    expect(container.querySelector('[aria-label="Show orchestrator log"]')).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("has no header before the first agent", () => {
    const { container, getByTestId } = render(<OrchestrationView {...props()} />);
    expect(container.querySelector('[data-slot="fleet-header"]')).toBeNull();
    expect(getByTestId("transcript")).toBeTruthy();
  });

  it("a spawn row opens the agent's detail", () => {
    h.agents = FLEET_METAS;
    const { getByTestId } = render(<OrchestrationView {...props()} />);
    act(() => openAgent?.("ios-orch-a2"));
    expect(getByTestId("agent-detail").textContent).toBe("ios-orch-a2");
  });
});
