import { useEffect, useState, type ReactNode } from "react";
import type { ComputerAppVerdict, ComputerServiceState } from "@server/shared/contract-computer";
import type { ActiveAppMode } from "@server/shared/computer/scheduleRules";
import { verdictWords } from "@server/shared/computer/words";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark, computerServiceMarkOf } from "../../components/ui/status";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import type { Link } from "../../lib/connection/link";
import { setComputerService, useComputerService } from "../../lib/computerSessions";
import {
  IDLE_MINUTES,
  appTitle,
  forgetComputerApps,
  idleMinutes,
  idleMs,
  onComputerSettings,
  readComputerSettings,
  retryComputerService,
  setComputerSettings,
  sortApps,
  useComputerPermissions,
} from "../../lib/tcserver/computerSettings";
import { CommitField } from "./hosts/CommitField";
import { PermissionRow } from "./PermissionRow";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** When a step that needs the app in front gets it (docs/computer-protocol.md §26.6). */
const ACTIVE_APP_CHOICES: { value: ActiveAppMode; label: string }[] = [
  { value: "brief", label: "Bring it forward for a moment" },
  { value: "away", label: "Wait until I'm away" },
];

/**
 * Settings › Computer use, on this Mac's own host: the service and how long
 * the person must be away before a thread may take the pointer and keyboard,
 * the two macOS grants, and every app TempCode learned with Forget.
 */
export function ComputerPage() {
  const link = registry.primary();
  const service = useComputerService(link.environmentId);
  const settings = useHostRead(link, () => readComputerSettings(link));
  const { set } = settings;
  const perms = useComputerPermissions(link, service);
  const [idleError, setIdleError] = useState<string | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);

  useEffect(() => onComputerSettings(link, set), [link, set]);

  const commitIdle = async (minutes: number | null): Promise<boolean> => {
    if (minutes === null) return false;
    try {
      set(await setComputerSettings(link, { sessionIdleMs: idleMs(minutes) }));
      setIdleError(null);
      return true;
    } catch (err) {
      setIdleError(message(err));
      return false;
    }
  };

  const chooseActiveApp = async (activeApp: ActiveAppMode): Promise<void> => {
    try {
      set(await setComputerSettings(link, { activeApp }));
      setActiveError(null);
    } catch (err) {
      setActiveError(message(err));
    }
  };

  const retryRead = (
    <Button variant="ghost" size="sm" onClick={settings.retry}>
      Retry
    </Button>
  );

  return (
    <>
      <PageSection>
        <ServiceRow link={link} service={service} />
        {settings.value ? (
          <PageRow title="Take the screen after" description="Minutes without input before a thread may use the pointer and keyboard." error={idleError}>
            <CommitField
              kind="int"
              aria-label="Take the screen after minutes"
              value={idleMinutes(settings.value.sessionIdleMs)}
              min={IDLE_MINUTES.min}
              max={IDLE_MINUTES.max}
              onCommit={commitIdle}
            />
          </PageRow>
        ) : settings.error ? (
          <PageError action={retryRead}>{settings.error}</PageError>
        ) : (
          <PageRowsSkeleton rows={[{ description: true, control: "number" }, { control: "select" }]} />
        )}
        {settings.value ? (
          <PageRow title="When a step needs the app in front" error={activeError}>
            <ChoiceSelect
              label="When a step needs the app in front"
              value={settings.value.activeApp}
              options={ACTIVE_APP_CHOICES}
              onChange={(choice) => void chooseActiveApp(choice)}
            />
          </PageRow>
        ) : null}
      </PageSection>

      <PageSection title="Permissions">
        {perms.value === null ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" onClick={perms.retry}>
                Retry
              </Button>
            }
          >
            Couldn't read the permissions
          </PageError>
        ) : perms.error ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" onClick={perms.retry}>
                Retry
              </Button>
            }
          >
            {perms.error}
          </PageError>
        ) : (
          <>
            <PermissionRow
              label="Accessibility"
              description="Reads apps and sends them input."
              granted={perms.value ? perms.value.accessibility : null}
              pane="Privacy_Accessibility"
            />
            <PermissionRow
              label="Screen Recording"
              description="Takes pictures of windows."
              granted={perms.value ? perms.value.screenRecording : null}
              pane="Privacy_ScreenCapture"
            />
          </>
        )}
      </PageSection>

      <AppsSection link={link} apps={settings.value?.apps} error={settings.error} retry={retryRead} onForgot={set} />
    </>
  );
}

/** The service's state; Try again only while it is down after crashes. */
function ServiceRow({ link, service }: { link: Link; service: ComputerServiceState | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!service) {
    return (
      <PageRow title="Service">
        <Skeleton className="h-3.5 w-20" />
      </PageRow>
    );
  }
  const mark = computerServiceMarkOf(service);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      setComputerService(link.environmentId, await retryComputerService(link));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    // a mark with its detail and Try again outgrow a narrow page: they take a line of their own there
    <PageRow title="Service" error={error} wide={mark.detail !== undefined}>
      <StatusMark state={mark.state} word={mark.word} detail={mark.detail} glyph={mark.state !== "idle"} />
      {service.state === "down" ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void retry()}>
          <BusyLabel busy={busy} label="Try again" />
        </Button>
      ) : null}
    </PageRow>
  );
}

/** Every app TempCode learned, with Forget; the next call to a forgotten app learns it again, so nothing confirms. */
function AppsSection({
  link,
  apps,
  error,
  retry,
  onForgot,
}: {
  link: Link;
  apps: ComputerAppVerdict[] | undefined;
  error: string | null;
  retry: ReactNode;
  onForgot: (settings: Awaited<ReturnType<typeof forgetComputerApps>>) => void;
}) {
  // the app being forgotten ("" for all), and a refusal with the key it belongs to
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; line: string } | null>(null);
  const forget = async (bundleId: string | null) => {
    const key = bundleId ?? "";
    setForgetting(key);
    setRefused(null);
    try {
      onForgot(await forgetComputerApps(link, bundleId));
    } catch (err) {
      setRefused({ key, line: message(err) });
    } finally {
      setForgetting(null);
    }
  };
  const sorted = apps ? sortApps(apps) : [];
  return (
    <PageSection
      title="Apps"
      action={
        sorted.length >= 2 ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={forgetting !== null} onClick={() => void forget(null)}>
            <BusyLabel busy={forgetting === ""} label="Forget all" />
          </Button>
        ) : null
      }
    >
      {refused?.key === "" ? <PageError>{refused.line}</PageError> : null}
      {apps ? (
        sorted.length ? (
          sorted.map((app) => {
            const name = appTitle(app);
            return (
              <PageRow
                key={app.bundleId}
                data-app={app.bundleId}
                title={name}
                description={verdictWords(app.classes) ?? undefined}
                error={refused?.key === app.bundleId ? refused.line : undefined}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Forget ${name}`}
                  disabled={forgetting !== null}
                  onClick={() => void forget(app.bundleId)}
                >
                  <BusyLabel busy={forgetting === app.bundleId} label="Forget" />
                </Button>
              </PageRow>
            );
          })
        ) : (
          <PageEmpty>No apps used yet</PageEmpty>
        )
      ) : error ? (
        <PageError action={retry}>{error}</PageError>
      ) : (
        <PageRowsSkeleton rows={[{ description: true, control: "button" }, { control: "button" }]} />
      )}
    </PageSection>
  );
}
