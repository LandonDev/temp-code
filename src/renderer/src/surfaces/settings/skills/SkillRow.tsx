import { harnessWords } from "@shared/skills";
import { scopeWords } from "@shared/addons";
import type { SkillMeta } from "@shared/contract-skills";
import { MoreHorizontal } from "../../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { useTruncated } from "../../../components/tip";
import { PageRow } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { Facts } from "../hosts/Facts";

export type SkillMenuPick = "edit" | "remove";
const MENU: MenuRow[] = [{ kind: "item", id: "edit", label: "Edit…" }, { kind: "sep" }, { kind: "item", id: "remove", label: "Remove…", danger: true }];

/** The row's third line: which CLIs get it, where it applies, its version, the thread that wrote it. */
export const skillFacts = (skill: SkillMeta, workspaceName: string | null): string[] => [
  harnessWords(skill.harnesses),
  scopeWords(workspaceName),
  `v${skill.version}`,
  ...(skill.writtenBy.kind === "thread" ? [`written by ${skill.writtenBy.title || "a thread"}`] : []),
];

/**
 * One skill on Settings → Skills: its name, its description on one line (cut,
 * and whole on the open control's tooltip only while cut), one comma run of
 * its CLIs, scope, version and the thread that wrote it, and a red line for
 * what the host refused. The switch and the ⋯ sit over the row's open
 * control, which opens Edit….
 */
export function SkillRowView({
  skill,
  workspaceName,
  blocked,
  error,
  onToggle,
  onPick,
}: {
  skill: SkillMeta;
  workspaceName: string | null;
  blocked: boolean;
  error?: string;
  onToggle: (on: boolean) => Promise<unknown>;
  onPick: (pick: SkillMenuPick) => void;
}) {
  const { ref, cut } = useTruncated(skill.description);
  return (
    <PageRow
      data-skill={skill.name}
      title={skill.name}
      description={
        <>
          <span ref={ref} data-skill-description className="block truncate">
            {skill.description}
          </span>
          <span className="mt-1 block">
            <Facts parts={skillFacts(skill, workspaceName)} />
          </span>
        </>
      }
      error={error}
      onOpen={() => onPick("edit")}
      openLabel={`Edit ${skill.name}`}
      openTip={cut ? skill.description : undefined}
      openDisabled={blocked}
    >
      <SettingSwitch label={skill.name} on={skill.enabled} disabled={blocked} onChange={onToggle} />
      <RowsMenu
        label={`${skill.name} actions`}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={`${skill.name} actions`} disabled={blocked} className="text-muted-foreground">
            <MoreHorizontal />
          </Button>
        }
        rows={MENU}
        onPick={(id) => onPick(id as SkillMenuPick)}
        align="end"
      />
    </PageRow>
  );
}
