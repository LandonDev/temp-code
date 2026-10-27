import type { RemoteKey, RemotePairing, RemoteSession } from "@server/shared/contract-remote";
import { Button } from "../../../components/ui/button";
import { Empty, EmptyTitle } from "../../../components/ui/empty";
import { ago } from "../../harnessLine";
import { capsText, originText } from "../../../lib/hostConnection";
import { Countdown } from "./dialogs/fields";
import { Facts } from "./Facts";
import { DANGER_GHOST, Group, Row } from "./Group";

/** "Chrome", "Safari", "Edge"…: the browser a session signed in from; "" when the agent names none. */
export function shortAgent(ua: string): string {
  const m = /(Edg|OPR|Chrome|Firefox|Safari|CriOS)\/[\d.]+/.exec(ua);
  return m ? m[0].split("/")[0].replace("CriOS", "Chrome").replace("OPR", "Opera").replace("Edg", "Edge") : "";
}

const kindText = (key: RemoteKey): string => (key.audience === "mcp" ? "Bot (MCP)" : key.kind === "browser" ? "Browser" : "App");

/** Every client that may reach this host: pairing codes not yet used, keys, and browsers signed in. */
export function Clients({
  pairings,
  keys,
  sessions,
  onPair,
  onNewKey,
  onAct,
}: {
  pairings: RemotePairing[];
  keys: RemoteKey[];
  sessions: RemoteSession[];
  onPair: () => void;
  onNewKey: () => void;
  onAct: (method: string, params: unknown) => void;
}) {
  const empty = pairings.length === 0 && keys.length === 0 && sessions.length === 0;
  return (
    <Group
      title="Clients"
      action={
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={onPair}>
            Pair a device
          </Button>
          <Button variant="secondary" size="sm" onClick={onNewKey}>
            New key
          </Button>
        </div>
      }
    >
      {empty ? (
        <Empty className="p-4">
          <EmptyTitle className="text-[13px] font-normal text-muted-foreground">No clients</EmptyTitle>
        </Empty>
      ) : null}
      {pairings.map((p) => (
        <Row
          key={p.id}
          data-client-pairing={p.id}
          title={p.name}
          description={<Facts parts={["Pairing code", capsText(p.caps)]} />}
        >
          <span className="text-xs tabular-nums text-muted-foreground">
            <Countdown prefix="expires in" at={p.expiresAt} />
          </span>
          <Button variant="ghost" size="sm" onClick={() => onAct("remote.pairings.revoke", { id: p.id })}>
            Cancel
          </Button>
        </Row>
      ))}
      {keys.map((k) => (
        <Row
          key={k.id}
          data-client-key={k.id}
          title={k.name}
          description={
            <Facts
              parts={[
                kindText(k),
                capsText(k.caps),
                ...(k.webhookUrl ? [`webhook ${originText(k.webhookUrl)}`] : []),
                k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : "never used",
              ]}
            />
          }
        >
          <Button variant="ghost" size="sm" className={DANGER_GHOST} onClick={() => onAct("remote.keys.revoke", { id: k.id })}>
            Revoke
          </Button>
        </Row>
      ))}
      {sessions.map((s) => (
        <Row
          key={s.id}
          data-client-session={s.id}
          title={s.keyName}
          description={<Facts parts={[shortAgent(s.userAgent ?? "") || "Browser", capsText(s.caps), `seen ${ago(s.lastSeenAt)}`]} />}
        >
          <Button variant="ghost" size="sm" className={DANGER_GHOST} onClick={() => onAct("remote.sessions.revoke", { id: s.id })}>
            Sign out
          </Button>
        </Row>
      ))}
    </Group>
  );
}
