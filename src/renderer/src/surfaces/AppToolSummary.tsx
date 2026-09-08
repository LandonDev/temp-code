import { useContext } from "react";
import { useTitlesOf } from "../lib/threadMentions";
import type { Block } from "../lib/session";
import { SelectSessionContext } from "./AgentMarkdown";
import { appThreadIds, appView, type AppView } from "./appTool";
import { useOpenAgentDetail } from "./agentDetailContext";

/** The app view of a call, kept current as thread titles arrive. */
export function useAppView(block: Block): AppView | null {
  const titleOf = useTitlesOf(appThreadIds(block));
  return appView(block, titleOf);
}

/**
 * A row for a call into the app itself: verb, then what it was about — a
 * thread's title when it names one, clickable to open that thread.
 */
export function AppToolSummary({
  view,
  chip = false,
  failed = false,
  agent = false,
}: {
  view: AppView;
  chip?: boolean;
  failed?: boolean;
  /** The thread is a subagent: open it in this pane's detail panel when one hosts it. */
  agent?: boolean;
}) {
  const onSelectSession = useContext(SelectSessionContext);
  const openDetail = useOpenAgentDetail();
  const open = agent && openDetail ? openDetail : onSelectSession;
  const actionTone = failed ? "text-red-400" : "text-content/50";
  const targetTone = failed ? "text-red-400" : chip ? "text-content/70" : "text-content/85";
  const link = view.threadId && open ? view.threadId : undefined;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-sans text-sm">
      <span className={`shrink-0 ${actionTone}`}>{view.label}</span>
      {link ? (
        <button
          type="button"
          className={`-my-0.5 min-w-0 truncate rounded px-1 py-0.5 text-left hover:text-sky-300 hover:underline ${
            chip ? `max-w-full bg-content/6 hover:bg-content/10 ${targetTone}` : targetTone
          }`}
          title={view.detail}
          onClick={(event) => {
            event.stopPropagation();
            open?.(link);
          }}
        >
          {view.detail}
        </button>
      ) : (
        <span className={`min-w-0 truncate ${targetTone}`} title={view.detail}>
          {view.detail}
        </span>
      )}
    </span>
  );
}
