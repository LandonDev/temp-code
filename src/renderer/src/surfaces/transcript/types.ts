// A7 (turn structure): the callback types the transcript's rows share, so no
// file under transcript/ imports AgentTranscript.tsx.
import type { ApprovalDecision } from "../../lib/harness";
import type { Block, HarnessId } from "../../lib/session";

export type ApprovalHandler = (requestId: string | number, decision: ApprovalDecision) => void;
/** Asks another harness about a turn (`turn` is the turn's blocks). */
export type SecondOpinionHandler = (harness: HarnessId, turn: Block[], model: string) => void;
/** Hands a turn to another harness. */
export type HandoffHandler = (harness: HarnessId, turn: Block[], model: string) => void;
