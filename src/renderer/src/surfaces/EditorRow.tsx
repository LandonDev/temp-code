import { EDITOR_IDS, EDITOR_LABELS, type EditorChoice } from "@shared/editor";
import { chooseEditorSetting, useEditorConfig } from "../lib/editorConfig";
import { Row, Segmented } from "./settingsBits";

/**
 * Settings → General: which editor "Open in …" and "Open on the Mac" hand a
 * file to. Auto takes the first of IDEA, VS Code and Xcode installed; a
 * Swift file under ios/ goes to Xcode when Xcode is chosen or IDEA is
 * absent. Absent in web mode and on a headless host, where no editor runs.
 */
export function EditorRow() {
  const config = useEditorConfig();
  if (!config) return null;
  const found = EDITOR_IDS.filter((id) => config.installed[id]).map((id) => EDITOR_LABELS[id]);
  const description =
    found.length === 0
      ? "No editor found. Install IntelliJ IDEA, VS Code or Xcode."
      : config.editor === "auto" && config.effective
        ? `Found ${listOf(found)}; Auto opens ${EDITOR_LABELS[config.effective]}.`
        : config.editor !== "auto" && !config.installed[config.editor]
          ? `${EDITOR_LABELS[config.editor]} is not installed; ${config.effective ? `${EDITOR_LABELS[config.effective]} opens instead` : "nothing opens"}.`
          : `Found ${listOf(found)}.`;
  const options: { value: EditorChoice; label: string }[] = [
    { value: "auto", label: "Auto" },
    ...EDITOR_IDS.map((id) => ({ value: id, label: EDITOR_LABELS[id] })),
  ];
  return (
    <Row label="Editor" description={description}>
      <Segmented
        label="Editor"
        value={config.editor}
        options={options}
        onChange={(choice) => void chooseEditorSetting(choice)}
      />
    </Row>
  );
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
