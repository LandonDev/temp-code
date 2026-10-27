import { useEffect, useRef, useState } from "react";
import { HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { BuildEditor, takeRequestedBuildFocus } from "../../chrome/rail/buildSettings";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { TurnPassEditor } from "../../chrome/TurnPassFields";
import { ProjectSettingsDialog } from "../../chrome/ProjectDialogs";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { ChevronRight } from "../../chrome/icons";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "../../components/ui/item";
import { registry } from "../../lib/connection";
import { openOrchestrationSettings, useRulesScope } from "../../lib/tcserver/rules";
import { useProjects, useWorkspaces } from "../../lib/tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceAccounts } from "../../lib/tcserver/projects";
import { useAccounts } from "../../stores/accounts";
import { shortName } from "../../lib/accountScope";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";

/**
 * One workspace's page: its overrides (anything untouched inherits the
 * global setting), its build, where its orchestration rules stand, and its
 * projects. The Build rail tab deep-links here with the Build section in
 * view.
 */
export function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const build = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A jump the person asked for: no smooth scroll.
    if (takeRequestedBuildFocus()) build.current?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <>
      <ThreadDefaultsEditor workspaceId={workspaceId} />
      <TurnPassEditor workspaceId={workspaceId} />
      {workspace ? <AccountsSection workspace={workspace} /> : null}
      <div id="settings-build" ref={build}>
        <PageSection title="Build">
          <BuildEditor workspaceId={workspaceId} />
        </PageSection>
      </div>
      <OrchestrationSection workspaceId={workspaceId} environmentId={workspace?.environmentId ?? registry.primary().environmentId} />
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
          >
            <ChoiceSelect
              label={`${HARNESS_TITLE[provider]} account`}
              value={current}
              disabled={profiles.length === 0 && current === ""}
              onChange={(next) => {
                const updated = { ...pins };
                if (next) updated[provider] = next;
                else delete updated[provider];
                void setWorkspaceAccounts(workspace.id, updated).catch(() => {});
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

function OrchestrationSection({ workspaceId, environmentId }: { workspaceId: string; environmentId: string }) {
  const { scope } = useRulesScope(environmentId, workspaceId);
  return (
    <PageSection title="Orchestration">
      <PageRow
        title="Rules"
        description={scope ? (scope.overridden ? "This workspace overrides the global rules." : "Following the global rules.") : undefined}
      >
        <Button variant="secondary" size="sm" onClick={() => openOrchestrationSettings(workspaceId)}>
          Edit rules
        </Button>
      </PageRow>
    </PageSection>
  );
}

function ProjectsSection({ workspace }: { workspace: WorkspaceMeta }) {
  const projects = useProjects()
    .filter((p) => p.workspaceId === workspace.id && !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [open, setOpen] = useState<ProjectMeta | null>(null);
  if (projects.length === 0) return null;
  return (
    <PageSection title="Projects">
      {projects.map((project) => (
        <Item
          key={project.id}
          data-slot="project-row"
          render={<button type="button" onClick={() => setOpen(project)} />}
          className="-mx-2 w-[calc(100%+1rem)] cursor-default border-0 px-2 py-2.5 text-start hover:bg-muted"
        >
          <ItemContent className="min-w-0">
            <ItemTitle>{project.name}</ItemTitle>
            <ItemDescription>
              <ProjectPins pins={project.accountPins} environmentId={workspace.environmentId} />
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </ItemActions>
        </Item>
      ))}
      {open ? <ProjectSettingsDialog project={open} workspace={workspace} onClose={() => setOpen(null)} /> : null}
    </PageSection>
  );
}

/** A project's pinned accounts, one span per provider; "Auto" with none. */
function ProjectPins({ pins, environmentId }: { pins: AccountPins | undefined; environmentId: string }) {
  const { snapshot } = useAccounts(environmentId);
  const pinned = ROUTED_PROVIDERS.filter((provider) => pins?.[provider]);
  if (pinned.length === 0) return <span>Auto</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {pinned.map((provider) => {
        const name = pins![provider]!;
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
