import { serverAdapter } from "../tcserver/adapter";
import { registerHarness } from "./registry";
import { HARNESSES } from "../session";

/** Every harness runs on the server. */
export const SERVER_HARNESSES = HARNESSES;

let registered = false;

/** Register all known live harness adapters. Idempotent. */
export function registerBuiltinHarnesses(): void {
  if (registered) return;
  registered = true;
  for (const id of SERVER_HARNESSES) registerHarness(serverAdapter(id));
}
