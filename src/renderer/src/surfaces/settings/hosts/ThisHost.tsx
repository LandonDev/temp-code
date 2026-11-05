import { useState } from "react";
import type { RemoteStatus } from "@server/shared/contract-remote";
import type { AttachmentSettings } from "@server/shared/contract-attachments";
import { SettingSwitch } from "../../../components/setting-switch";
import { forgetAttachmentSettings } from "../../../lib/attachmentUpload";
import { CommitField } from "./CommitField";
import { Row } from "./Group";

type SettingsPatch = { enabled?: boolean; port?: number; publicOrigin?: string; stuckMinutes?: number };

/** "Listening on 127.0.0.1:7677.", with the environment variable named when it overrides the setting. */
export function listenerText(status: RemoteStatus): string {
  if (status.running) {
    const overridden = status.port !== status.configuredPort;
    return `Listening on 127.0.0.1:${status.port}${overridden ? " (TEMP_CODE_REMOTE_PORT overrides the setting)" : ""}.`;
  }
  if (status.error) return status.error;
  return status.enabled ? "Off (TEMP_CODE_REMOTE_PORT=0)." : "Off.";
}

type Field = "enabled" | "port" | "publicOrigin" | "stuckMinutes" | "attachments";

/** This machine's own rows, under its heading: the listener and its port,
 *  the pairing origin, the stuck clock and the attachment limit. A refused
 *  change is said under its own row; `error` (the listener's poll) is
 *  Remote access's alone. */
export function ThisHost({
  status,
  attachments,
  error,
  onSettings,
  onAct,
}: {
  status: RemoteStatus;
  attachments: AttachmentSettings | null;
  error: string | null;
  /** Each resolves null once the change landed, else why it did not. */
  onSettings: (patch: SettingsPatch) => Promise<string | null>;
  onAct: (method: string, params: unknown) => Promise<string | null>;
}) {
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  /** Runs a change, keeps its failure on its row, and resolves whether it landed (a switch slides back, a field restores its value). */
  const run = async (field: Field, change: Promise<string | null>): Promise<boolean> => {
    setErrors(({ [field]: _gone, ...rest }) => rest);
    const failure = await change;
    if (failure !== null) setErrors((prev) => ({ ...prev, [field]: failure }));
    return failure === null;
  };
  return (
    <>
      <Row title="Remote access" description={listenerText(status)} error={errors.enabled ?? error}>
        <SettingSwitch label="Remote access" on={status.enabled} onChange={(enabled) => run("enabled", onSettings({ enabled }))} />
      </Row>
      <Row title="Port" error={errors.port}>
        <CommitField
          kind="int"
          aria-label="Port"
          value={status.configuredPort}
          min={1}
          max={65535}
          onCommit={(port) => (port === null ? undefined : run("port", onSettings({ port })))}
        />
      </Row>
      <Row
        title="Public origin"
        wide
        description={
          status.publicOrigin
            ? "Pairing links start with this."
            : `Pairing links start with ${status.origin}${status.learnedOrigin ? ", learned from the tunnel" : ""}.`
        }
        error={errors.publicOrigin}
      >
        <CommitField
          aria-label="Public origin"
          value={status.publicOrigin}
          placeholder="https://tempcode.example.com"
          className="w-64 @max-[30rem]/page:w-full"
          onCommit={(publicOrigin) => run("publicOrigin", onSettings({ publicOrigin }))}
        />
      </Row>
      <Row title="Stuck after" description="Minutes of silence before a working thread is stuck." error={errors.stuckMinutes}>
        <CommitField
          kind="int"
          aria-label="Stuck after minutes"
          value={status.stuckMinutes}
          min={1}
          max={1440}
          onCommit={(stuckMinutes) => (stuckMinutes === null ? undefined : run("stuckMinutes", onSettings({ stuckMinutes })))}
        />
      </Row>
      {attachments ? (
        <Row title="Attachment limit" description="Largest upload or paste, in MB." error={errors.attachments}>
          <CommitField
            kind="int"
            aria-label="Attachment limit in MB"
            value={Math.round(attachments.maxBytes / 1024 / 1024)}
            min={1}
            max={100_000}
            onCommit={(mb) => {
              if (mb === null) return;
              forgetAttachmentSettings();
              return run("attachments", onAct("attachment.settings.set", { maxBytes: mb * 1024 * 1024 }));
            }}
          />
        </Row>
      ) : null}
    </>
  );
}
