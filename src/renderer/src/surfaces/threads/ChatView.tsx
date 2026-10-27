import type { ThreadViewProps } from "./ThreadView";

export function ChatView(props: ThreadViewProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col [contain:layout_style]">
      {props.renderChat()}
    </div>
  );
}
