import { useEnvironments } from "../lib/connection/status";
import { useHostPlatform } from "../lib/hostPlatform";
import { Tip } from "../components/tip";
import { CloudServer, Laptop } from "./icons";

/**
 * Which host a thread or agent lives on: a laptop for a Mac, a server for
 * anything else, 12 px and muted, the host's name on hover. Drawn only when
 * the window knows two or more hosts; with one there is nothing to tell
 * apart. Monochrome on purpose: colour on a row is for status dots. `bare`
 * drops its own tooltip, for a glyph inside a control whose tooltip names
 * the host (a header chip).
 */
export function HostGlyph({
  environmentId,
  title,
  bare = false,
  className = "",
}: {
  environmentId: string | null | undefined;
  /** Replaces the host's name on hover (a row that says its host is offline). */
  title?: string;
  bare?: boolean;
  className?: string;
}) {
  const environments = useEnvironments();
  const platform = useHostPlatform(environmentId ?? undefined);
  if (!environmentId || environments.length < 2) return null;
  const name = environments.find((e) => e.id === environmentId)?.name ?? environmentId;
  const mac = platform === "darwin";
  const Icon = mac ? Laptop : CloudServer;
  const label = title ?? name;
  const glyph = (
    <span
      role="img"
      aria-label={label}
      data-host-glyph={environmentId}
      data-host-kind={mac ? "mac" : "server"}
      className={`inline-flex shrink-0 text-muted-foreground ${className}`}
    >
      <Icon className="size-3" strokeWidth={1.75} aria-hidden />
    </span>
  );
  return bare ? glyph : <Tip label={label}>{glyph}</Tip>;
}
