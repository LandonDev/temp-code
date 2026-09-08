import type { HarnessAdapter } from "../harness/registry";
import type { HarnessId, Session } from "../session";
import { refreshCatalog } from "./catalog";
import * as commands from "./commands";
import { sessionStore } from "./store";
import {
  generateServerBranchName,
  generateServerCommitMessage,
  generateServerPrContent,
} from "./text";

/**
 * The registry-facing adapter for a harness the server runs. Every
 * method is a thin call into commands.ts; events reach the UI through
 * the store, never through `onEvent`. Stop/forget/bind are no-ops — the
 * server owns the harness process and its resume state.
 */
export function serverAdapter(id: HarnessId): HarnessAdapter {
  const sessionFor = (input: {
    sessionId: string;
    cwd: string;
    model: string;
    modelSettings?: Record<string, string>;
    runtimeMode?: Session["runtimeMode"];
  }): Session =>
    sessionStore.get(input.sessionId) ?? {
      id: input.sessionId,
      harness: id,
      model: input.model,
      modelSettings: input.modelSettings ?? {},
      runtimeMode: input.runtimeMode ?? "supervised",
      title: id,
      cwd: input.cwd,
      blocks: [],
    };
  return {
    id,
    live: true,
    canSteer: true,
    idlePark: false,
    async sendTurn(input) {
      const session = sessionFor(input);
      if (!sessionStore.get(session.id)) sessionStore.mutate((prev) => [...prev, session]);
      await commands.send(
        { ...session, harness: id, model: input.model, modelSettings: input.modelSettings ?? session.modelSettings, runtimeMode: input.runtimeMode },
        input.text,
        input.attachments ?? [],
      );
    },
    async steerTurn(input) {
      await commands.steer(sessionFor(input), input.text, input.attachments ?? []);
    },
    cancelTurn: (sessionId) => commands.interrupt(sessionId),
    respondApproval(sessionId, requestId, decision) {
      void commands.approve(sessionId, requestId, decision === "allow");
    },
    stopSession: async () => {},
    forgetSession: async () => {},
    bindSession: () => {},
    refreshCatalog,
    generateTitle: async () => null,
    generateCommitMessage: generateServerCommitMessage,
    generatePrContent: generateServerPrContent,
    generateBranchName: generateServerBranchName,
    warmupText: async () => {},
  };
}
