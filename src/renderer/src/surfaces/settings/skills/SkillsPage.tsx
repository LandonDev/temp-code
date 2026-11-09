import { useState } from "react";
import type { Skill, SkillMeta } from "@shared/contract-skills";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { PageActions, PageEmpty, PageError, PageRowsSkeleton, PageSection } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { registry, type Link } from "../../../lib/connection";
import { homeNote, refusalWords } from "../../../lib/settingsHome";
import { useWorkspaces } from "../../../lib/tcserver/workspaces";
import { scopeName } from "../addons/addonWords";
import { SkillDialog } from "./SkillDialog";
import { SkillRowView, type SkillMenuPick } from "./SkillRow";
import { useSkillsPage } from "./useSkills";

/**
 * Settings → Skills (docs/LAYOUT.md "Settings → Add-ons and Skills"): one
 * list of every skill this host knows, the scope said on each row, New
 * skill… on the page's title line. Reads through this machine; every write
 * goes to the scope's home and carries the row's `updatedAt`, so a skill that
 * moved since it was read is refused rather than written over.
 */
export function SkillsPage() {
  return <SkillsBody link={registry.primary()} />;
}

export function SkillsBody({ link }: { link: Link }) {
  const { data, error, retry, replaceRow, dropRow } = useSkillsPage(link);
  const [editing, setEditing] = useState<SkillMeta | "new" | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const workspaces = useWorkspaces().filter((w) => w.environmentId === link.environmentId);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const { note, blocked } = homeNote(data?.home);

  const act = <T,>(skill: SkillMeta, run: () => Promise<T>): Promise<T | false> => {
    setRowErrors((cur) => {
      if (!(skill.id in cur)) return cur;
      const next = { ...cur };
      delete next[skill.id];
      return next;
    });
    return run().catch((err: unknown) => {
      setRowErrors((cur) => ({ ...cur, [skill.id]: refusalWords(err) || "The host refused it" }));
      return false as const;
    });
  };

  // A skill is written whole, so a flip reads its files first.
  const toggle = (skill: SkillMeta, enabled: boolean) =>
    act(skill, async () => {
      const { skill: whole } = await link.request<{ skill: Skill }>("skills.get", { id: skill.id });
      const { skill: saved } = await link.request<{ skill: SkillMeta }>("skills.set", {
        skill: { id: skill.id, name: skill.name, workspaceId: skill.workspaceId, harnesses: skill.harnesses, enabled, files: whole.files },
        expectUpdatedAt: skill.updatedAt,
      });
      replaceRow(saved);
    });

  const pick = (skill: SkillMeta, id: SkillMenuPick) => {
    if (id === "edit") {
      setEditing(skill);
      return;
    }
    void confirmAction({ title: `Remove the skill ${skill.name}`, body: "Threads that start from now no longer get it.", action: "Remove", danger: true }).then((ok) => {
      if (ok) void act(skill, () => link.request("skills.remove", { id: skill.id, expectUpdatedAt: skill.updatedAt }).then(() => dropRow(skill.id)));
    });
  };

  return (
    <>
      <PageActions>
        <Button variant="ghost" size="sm" disabled={!data || blocked} onClick={() => setEditing("new")}>
          New skill…
        </Button>
      </PageActions>
      <PageSection description={note}>
        {!data ? (
          error ? (
            <PageError
              action={
                <Button variant="ghost" size="sm" onClick={retry}>
                  Retry
                </Button>
              }
            >
              {error}
            </PageError>
          ) : (
            <PageRowsSkeleton rows={3} description={2} control="switch" />
          )
        ) : data.skills.length === 0 ? (
          <PageEmpty>No skills</PageEmpty>
        ) : (
          data.skills.map((skill) => (
            <SkillRowView
              key={skill.id}
              skill={skill}
              workspaceName={scopeName(skill.workspaceId, names)}
              blocked={blocked}
              error={rowErrors[skill.id]}
              onToggle={(on) => toggle(skill, on)}
              onPick={(id) => pick(skill, id)}
            />
          ))
        )}
      </PageSection>
      {editing ? (
        <SkillDialog
          link={link}
          skill={editing === "new" ? null : editing}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            replaceRow(saved);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}
