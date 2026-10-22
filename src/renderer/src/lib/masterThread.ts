/** Is this session a master thread (CLAUDE.md "Master threads")? The pin
 *  lives on the thread's row (`isMaster`); a subagent is never one. */
export function isMasterThread(session: { parentId?: string | null; isMaster?: boolean }): boolean {
  return !!session.isMaster && !session.parentId;
}
