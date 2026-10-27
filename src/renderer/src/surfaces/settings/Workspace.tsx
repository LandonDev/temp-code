import { HARNESS_LABEL } from "../../lib/session";
import { BuildEditor } from "../../chrome/rail/buildSettings";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { TurnPassEditor } from "../../chrome/TurnPassFields";
import { openOrchestrationSettings } from "../../lib/tcserver/rules";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceAccounts } from "../../lib/tcserver/projects";
import { useAccounts } from "../../stores/accounts";
import { shortName } from "../../lib/accountScope";
import { ROUTED_PROVIDERS } from "@server/shared/accounts";
import {
  Heading,
  Row,
  Select,
  SecondaryButton,
} from "../settingsBits";

/** Global rules, or one workspace's whole-object override, picked by scope.
 *  The workspace menu deep-links here with its workspace preselected. */
/**
 * One workspace's overrides. Anything untouched inherits the global setting;
 * orchestration rules edit on their own page with this workspace in scope.
 */
export function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <ThreadDefaultsEditor workspaceId={workspaceId} first />
      <TurnPassEditor workspaceId={workspaceId} />
      <Heading title="Accounts" />
      <WorkspaceAccountsEditor workspaceId={workspaceId} />
      <Heading title="Build" />
      <BuildEditor workspaceId={workspaceId} />
      <Heading title="Orchestration" />
      <Row
        label="Rules"
        description="What threads that spawn subagents may do themselves, and where each kind of work goes."
      >
        <SecondaryButton onClick={() => openOrchestrationSettings(workspaceId)}>
          Edit rules
        </SecondaryButton>
      </Row>
    </>
  );
}

/**
 * The Aliax account this workspace's threads spend from, per provider.
 * Auto picks by model and moves a thread when its account runs out; a
 * project or a thread can still pin its own.
 */
function WorkspaceAccountsEditor({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace) return null;
  return <WorkspaceAccountsForHost workspace={workspace} />;
}

function WorkspaceAccountsForHost({ workspace }: { workspace: WorkspaceMeta }) {
  const workspaceId = workspace.id;
  const { snapshot } = useAccounts(workspace.environmentId);
  const pins = workspace.accountPins ?? {};
  return (
    <>
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = pins[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        return (
          <Row
            key={provider}
            label={HARNESS_LABEL[provider]}
            description={
              provider === "claude"
                ? "Which Aliax account threads here spend from. Auto picks by model and moves a thread when its account runs out."
                : undefined
            }
          >
            <Select
              label={`${HARNESS_LABEL[provider]} account`}
              value={known ? current : ""}
              disabled={profiles.length === 0 && current === ""}
              onChange={(next) => {
                const updated = { ...pins };
                if (next) updated[provider] = next;
                else delete updated[provider];
                void setWorkspaceAccounts(workspaceId, updated).catch(() => {});
              }}
              options={[
                { value: "", label: "Auto" },
                ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
                ...(known ? [] : [{ value: current, label: `${current} (not in Aliax)` }]),
              ]}
            />
          </Row>
        );
      })}
    </>
  );
}
