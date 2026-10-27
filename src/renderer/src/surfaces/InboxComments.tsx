import { openUrl } from "../lib/native";
import { Button } from "../components/ui/button";
import { Tip } from "../components/tip";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { X } from "../chrome/icons";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import {
  formatRelativeTime,
  githubReviewStateLabel,
  inboxPersonAvatarUrl,
  type InboxProvider,
} from "../lib/githubTasks";
import { MOD } from "../lib/platform";
import { AgentMarkdown } from "./AgentMarkdown";

export type InboxReplyTarget = {
  id: string;
  author: string;
  threadId: string;
};

type InboxComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId?: string;
  replies: InboxComment[];
};

type InboxThread = {
  comments: InboxComment[];
  truncated: boolean;
};

type Props = {
  thread: InboxThread | null;
  loading: boolean;
  error: string | null;
  cwd: string;
  provider: InboxProvider;
  replyMode?: "thread" | "parent";
  onReply?: (target: InboxReplyTarget) => void;
};

export function InboxComments({
  thread,
  loading,
  error,
  cwd,
  provider,
  replyMode,
  onReply,
}: Props) {
  if (thread && thread.comments.length === 0 && !thread.truncated) {
    if (loading) return <CommentsPending />;
    return null;
  }
  if (!thread) {
    if (error) {
      return <p className="text-[12px] text-destructive">{error}</p>;
    }
    if (loading) return <CommentsPending />;
    return null;
  }

  const count = thread.comments.reduce(
    (total, comment) => total + 1 + comment.replies.length,
    0,
  );
  const label = count === 1 ? "1 comment" : `${count} comments`;
  const moreOn = provider === "linear" ? "Linear" : "GitHub";

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-5">
      <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
        <h2 className="font-medium">{label}</h2>
        {thread.truncated ? <span>the latest, more on {moreOn}</span> : null}
        {loading ? <Spinner aria-label="Loading comments" className="size-3" /> : null}
      </div>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <InboxComment
              comment={comment}
              cwd={cwd}
              provider={provider}
              replyMode={replyMode}
              onReply={onReply}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function InboxCommentForm({
  replyTo,
  posting,
  error,
  onCancelReply,
  onSubmit,
}: {
  replyTo: InboxReplyTarget | null;
  posting: boolean;
  error: string | null;
  onCancelReply: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const canPost = draft.trim().length > 0 && !posting;

  useEffect(() => {
    if (!replyTo) return;
    field.current?.focus();
  }, [replyTo]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    try {
      await onSubmit(body);
      setDraft("");
    } catch {
      // Parent keeps the error next to the button.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <form
      onSubmit={onFormSubmit}
      className="flex flex-col gap-2 border-t border-border pt-5"
    >
      {replyTo ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="min-w-0 truncate">
            Replying to {replyTo.author || "comment"}
          </span>
          <Tip label="Cancel reply">
            <Button variant="ghost" size="icon-xs" aria-label="Cancel reply" onClick={onCancelReply} className="shrink-0 text-muted-foreground">
              <X className="size-3" strokeWidth={1.75} />
            </Button>
          </Tip>
        </div>
      ) : null}
      <Textarea
        ref={field}
        rows={2}
        value={draft}
        disabled={posting}
        aria-label={replyTo ? "Reply" : "Comment"}
        placeholder={
          replyTo ? `Write a reply (${MOD}↩)` : `Leave a comment (${MOD}↩)`
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 resize-none overflow-y-auto px-3 leading-5 text-foreground"
      />
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 pt-1 text-[12px] text-destructive">
          {error}
        </p>
        <Button type="submit" size="sm" variant="secondary" disabled={!canPost}>
          {posting ? <Spinner aria-hidden className="size-3" /> : null}
          {posting ? "Posting…" : replyTo ? "Reply" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

function CommentsPending() {
  return (
    <div
      role="status"
      aria-busy
      className="flex items-center gap-2 border-t border-border pt-5 text-[12px] text-muted-foreground"
    >
      <Spinner aria-hidden className="size-3.5" />
      Loading comments
    </div>
  );
}

function InboxComment({
  comment,
  cwd,
  provider,
  nested = false,
  replyMode,
  onReply,
}: {
  comment: InboxComment;
  cwd: string;
  provider: InboxProvider;
  nested?: boolean;
  replyMode?: "thread" | "parent";
  onReply?: (target: InboxReplyTarget) => void;
}) {
  const time = formatRelativeTime(comment.createdAt);
  const review = githubReviewStateLabel(comment.state);
  const location = commentLocation(comment);
  const meta = [
    review,
    location,
    comment.resolved ? "Resolved" : "",
    time,
  ].filter((part) => part.length > 0);
  const hasBody = comment.body.trim().length > 0;
  const hasReplies = !nested && comment.replies.length > 0;
  const canReply =
    onReply != null &&
    (replyMode === "parent" ||
      (replyMode === "thread" && (comment.threadId ?? "").trim().length > 0));

  const inner = (
    <>
      <header
        className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground ${
          nested ? "" : "px-3 py-2"
        } ${!nested && (hasBody || hasReplies) ? "border-b border-border" : ""}`}
      >
        <InboxCommentPerson
          name={comment.author || "ghost"}
          avatarUrl={inboxPersonAvatarUrl(
            provider,
            comment.author,
            comment.authorAvatarUrl,
          )}
        />
        {meta.map((part, index) =>
          comment.url && part === time ? (
            <Tip
              key={`${part}-${index}`}
              label={provider === "linear" ? "Open in Linear" : "Open on GitHub"}
            >
              <Button variant="link" size="xs" onClick={() => void openUrl(comment.url)} className="h-auto shrink-0 p-0 text-[length:inherit] font-normal tabular-nums text-inherit">
                {part}
              </Button>
            </Tip>
          ) : (
            <span
              key={`${part}-${index}`}
              className={
                part === review && comment.state === "APPROVED"
                  ? "text-success"
                  : part === review && comment.state === "CHANGES_REQUESTED"
                    ? "text-destructive"
                    : comment.resolved && part === "Resolved"
                      ? "text-success"
                      : "min-w-0 truncate"
              }
            >
              {part}
            </span>
          ),
        )}
        {canReply ? (
          <Button
            variant="link"
            size="xs"
            onClick={() =>
              onReply({
                id: comment.id,
                author: comment.author || "ghost",
                threadId: (comment.threadId ?? "").trim(),
              })
            }
            className="h-auto shrink-0 p-0 text-[length:inherit] font-normal text-inherit hover:text-foreground hover:no-underline"
          >
            Reply
          </Button>
        ) : null}
      </header>
      {hasBody ? (
        <div className={nested ? "mt-2" : "px-3 py-2.5"}>
          <AgentMarkdown
            className="inbox-comment-md"
            text={comment.body}
            cwd={cwd}
          />
        </div>
      ) : null}
      {hasReplies ? (
        <div className="border-t border-border px-3">
          {comment.replies.map((reply, index) => (
            <div
              key={reply.id}
              className={`py-2.5 ${
                index > 0 ? "border-t border-border" : ""
              }`}
            >
              <InboxComment
                comment={reply}
                cwd={cwd}
                provider={provider}
                nested
                replyMode={replyMode}
                onReply={onReply}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  if (nested) return <article>{inner}</article>;
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card">
      {inner}
    </article>
  );
}

function commentLocation(comment: InboxComment): string {
  const path = comment.path.trim();
  if (!path) return "";
  if (comment.line && comment.line > 0) return `${path}:${comment.line}`;
  return path;
}

function InboxCommentPerson({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string;
}) {
  const [failed, setFailed] = useState(!avatarUrl);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  useEffect(() => {
    setFailed(!avatarUrl);
  }, [avatarUrl]);

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt=""
          width={20}
          height={20}
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-5 shrink-0 rounded-full bg-muted object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
        >
          {initial}
        </span>
      )}
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    </span>
  );
}
