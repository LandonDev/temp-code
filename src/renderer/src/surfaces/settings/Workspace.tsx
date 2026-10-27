import { useEffect, useRef, useState, type ReactNode } from "react";
import { HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { BuildEditor, takeRequestedBuildFocus } from "../../chrome/rail/buildSettings";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { TurnPassEditor } from "../../chrome/TurnPassFields";
import { ProjectSettingsDialog } from "../../chrome/ProjectDialogs";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { takeRequestedRulesFocus } from "../../lib/tcserver/rules";
import { OrchestrationRulesEditor } from "../../chrome/OrchestrationRules";
import { useProjects, useWorkspaces } from "../../lib/tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceAccounts } from "../../lib/tcserver/projects";
import { useAccounts } from "../../stores/accounts";
import { shortName } from "../../lib/accountScope";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";

/**
 * One workspace's page: its overrides (anything untouched inherits the
 * global setting), its build, its orchestration rules and its projects.
 * The Build rail tab and the workspace menu's rules item deep-link here
 * with their section in view.
 */
export function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const build = useRef<HTMLDivElement>(null);
  const rules = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A jump the person asked for: no smooth scroll. Focus lands on the
    // section, so the next Tab reaches its first control.
    const target = takeRequestedBuildFocus() ? build.current : takeRequestedRulesFocus() ? rules.current : null;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <ThreadDefaultsEditor workspaceId={workspaceId} />
      <TurnPassEditor workspaceId={workspaceId} />
      {workspace ? <AccountsSection workspace={workspace} /> : null}
      <div id="settings-build" ref={build} tabIndex={-1} className="outline-none">
        <PageSection title="Build">
          <BuildEditor workspaceId={workspaceId} />
        </PageSection>
      </div>
      <div id="settings-orchestration" ref={rules} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        <OrchestrationRulesEditor workspaceId={workspaceId} />
      </div>
      {workspace ? <ProjectsSection workspace={workspace} /> : null}
    </>
  );
}

/**
 * The Aliax account this workspace's threads spend from, per provider.
 * Auto picks by model and moves a thread when its account runs out; a
 * project or a thread can still pin its own.
 */
function AccountsSection({ workspace }: { workspace: WorkspaceMeta }) {
  const { snapshot } = useAccounts(workspace.environmentId);
  const pins = workspace.accountPins ?? {};
  const [error, setError] = useState<{ provider: string; message: string } | null>(null);
  return (
    <PageSection title="Accounts" description="Auto picks by model and moves a thread when its account runs out.">
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = pins[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        return (
          <PageRow
            key={provider}
            media={<HarnessIcon harness={provider as HarnessId} className="size-4 shrink-0" />}
            title={HARNESS_TITLE[provider]}
            error={error?.provider === provider ? error.message : undefined}
          >
            <ChoiceSelect
              label={`${HARNESS_TITLE[provider]} account`}
              value={current}
              disabled={profiles.length === 0 && current === ""}
              onChange={(next) => {
                const updated = { ...pins };
                if (next) updated[provider] = next;
                else delete updated[provider];
                setError(null);
                void setWorkspaceAccounts(workspace.id, updated).catch((err) =>
                  setError({ provider, message: err instanceof Error ? err.message : String(err) }),
                );
              }}
              options={[
                { value: "", label: "Auto" },
                ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
                ...(known ? [] : [{ value: current, label: `${current} (not in Aliax)` }]),
              ]}
            />
          </PageRow>
        );
      })}
    </PageSection>
  );
}

function ProjectsSection({ workspace }: { workspace: WorkspaceMeta }) {
  const { snapshot } = useAccounts(workspace.environmentId);
  const projects = useProjects()
    .filter((p) => p.workspaceId === workspace.id && !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [open, setOpen] = useState<ProjectMeta | null>(null);
  if (projects.length === 0) return null;
  return (
    <PageSection title="Projects">
      {projects.map((project) => (
        <PageRow
          key={project.id}
          title={project.name}
          description={pinsLine({ ...workspace.accountPins, ...project.accountPins }, snapshot)}
        >
          <Button variant="ghost" size="sm" aria-label={`${project.name} settings`} onClick={() => setOpen(project)}>
            Settings…
          </Button>
        </PageRow>
      ))}
      {open ? <ProjectSettingsDialog project={open} workspace={workspace} onClose={() => setOpen(null)} /> : null}
    </PageSection>
  );
}

/** The accounts a project's threads spend from (its pins over the workspace's), one span per provider; nothing when none is pinned. */
function pinsLine(pins: AccountPins, snapshot: ReturnType<typeof useAccounts>["snapshot"]): ReactNode {
  const pinned = ROUTED_PROVIDERS.filter((provider) => pins[provider]);
  if (pinned.length === 0) return undefined;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {pinned.map((provider) => {
        const name = pins[provider]!;
        const profile = snapshot.providers[provider].profiles.find((p) => p.name === name);
        return (
          <span key={provider} className="inline-flex items-center gap-1">
            <HarnessIcon harness={provider as HarnessId} className="size-3 shrink-0" />
            {profile ? shortName(profile) : name}
          </span>
        );
      })}
    </span>
  );
}
