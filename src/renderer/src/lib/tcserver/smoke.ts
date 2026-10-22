import { invoke } from "../native";
import { registry } from "../connection";
import type { AgentEvent, CreateSessionInput, SessionMeta } from "./types";

const SMOKE_TIMEOUT_MS = 90_000;

export interface SmokeResult {
  sessionId: string;
  text: string;
  costUsd?: number;
  ms: number;
}

/**
 * One scripted Claude turn through the sidecar: create a session, subscribe,
 * send "reply pong", collect the streamed text, resolve on turn-complete.
 * Run from devtools as `await __monocode.smoke("local")`.
 */
export async function smoke(environmentId: string, cwd?: string): Promise<SmokeResult> {
  const t0 = performance.now();
  const client = registry.linkOf(environmentId);
  const dir = cwd ?? (await invoke<string>("default_cwd"));
  const input: CreateSessionInput = {
    provider: "claude",
    cwd: dir,
    agentType: "implementer",
    title: "sidecar smoke",
  };
  const session = await client.request<SessionMeta>("session.create", input);
  const sessionId = session.id;
  await client.request("session.subscribe", { sessionId });

  const result = new Promise<SmokeResult>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      done();
      reject(new Error(`smoke: no turn-complete after ${SMOKE_TIMEOUT_MS} ms`));
    }, SMOKE_TIMEOUT_MS);
    const off = client.onPush((push) => {
      // Every socket's rows arrive coalesced (`events`); a single `event` still reads.
      const rows = push.push === "events" ? push.rows : push.push === "event" ? [push.row] : [];
      for (const row of rows) if (row.sessionId === sessionId) onEvent(row.event);
    });
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === "assistant-text") {
        text = ev.delta ? text + ev.text : ev.text;
        console.debug("[smoke] Δ", JSON.stringify(ev.text));
      } else if (ev.type === "turn-complete") {
        done();
        resolve({
          sessionId,
          text: text.trim(),
          costUsd: ev.costUsd,
          ms: Math.round(performance.now() - t0),
        });
      } else if (ev.type === "error") {
        done();
        reject(new Error(`smoke: ${ev.message}`));
      }
    };
    const done = () => {
      clearTimeout(timer);
      off();
      void client.request("session.unsubscribe", { sessionId }).catch(() => {});
    };
  });

  await client.request("session.send", {
    sessionId,
    text: "Reply with the single word pong.",
  });
  const r = await result;
  console.info(
    `[smoke] "${r.text}" in ${r.ms} ms` +
      (r.costUsd !== undefined ? `, $${r.costUsd.toFixed(4)}` : ""),
  );
  return r;
}
