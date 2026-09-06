import { invoke } from "../native";
import { client } from "./client";
import type { CreateSessionInput, SessionMeta } from "./types";

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
 * Run from devtools as `await __monocode.smoke()`.
 */
export async function smoke(cwd?: string): Promise<SmokeResult> {
  const t0 = performance.now();
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
      if (push.push !== "event" || push.row.sessionId !== sessionId) return;
      const ev = push.row.event;
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
    });
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
