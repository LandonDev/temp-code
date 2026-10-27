import { useState } from "react";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import {
  applyThemePreference,
  EDITOR_FONT_SIZES,
  loadEditorFontSize,
  loadThemePreference,
  saveEditorFontSize,
  saveThemePreference,
  type EditorFontSize,
  type ThemePreference,
} from "../../lib/appearance";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FONT_SIZES = EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` }));

export function AppearancePage() {
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [fontSize, setFontSize] = useState<EditorFontSize>(loadEditorFontSize);
  return (
    <PageSection>
      <PageRow title="Theme">
        <ChoiceSelect
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={(next) => {
            applyThemePreference(next);
            saveThemePreference(next);
            setTheme(next);
          }}
        />
      </PageRow>
      <PageRow title="Editor font size">
        <ChoiceSelect
          label="Editor font size"
          value={String(fontSize)}
          options={FONT_SIZES}
          onChange={(next) => setFontSize(saveEditorFontSize(Number(next)))}
        />
      </PageRow>
    </PageSection>
  );
}
