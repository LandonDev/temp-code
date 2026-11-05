import { clockTime as clock } from "./duration";
import type { SteerStamp } from "./session";

/** The one word under a steered bubble (UserMessage's SteerLine). */
export function steerWord(stamp: SteerStamp): string {
  switch (stamp.state) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "queued":
      return "Queued for the next turn";
    case "failed":
      return "Not delivered";
  }
}

/** Its tooltip: when, and how it went in ("Received at 2:02 PM, as its own turn"). */
export function steerTip(stamp: SteerStamp): string {
  if (stamp.state === "failed") return stamp.reason ? `Not delivered: ${stamp.reason}` : `Not delivered at ${clock(stamp.ts)}`;
  const word = stamp.state === "queued" ? "Queued" : steerWord(stamp);
  return `${word} at ${clock(stamp.ts)}${stamp.state === "received" && stamp.how === "next-turn" ? ", as its own turn" : ""}`;
}
