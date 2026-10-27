import { useCallback, useState } from "react";
import {
  applyBodyGlass,
  applyGlass,
  applyThemePreference,
  applySidebarOpacity,
  applyThemeTint,
  BODY_GLASS_DEFAULT,
  GLASS_DEFAULT,
  THEME_PREFERENCE_DEFAULT,
  loadBodyGlass,
  loadGlass,
  loadThemePreference,
  loadSidebarOpacity,
  loadThemeHue,
  loadThemeSaturation,
  saveBodyGlass,
  saveGlass,
  saveThemePreference,
  saveSidebarOpacity,
  saveThemeHue,
  saveThemeSaturation,
  SIDEBAR_OPACITY_DEFAULT,
  SIDEBAR_OPACITY_MAX,
  SIDEBAR_OPACITY_MIN,
  THEME_HUE_DEFAULT,
  THEME_HUE_MAX,
  THEME_HUE_MIN,
  THEME_SATURATION_DEFAULT,
  THEME_SATURATION_MAX,
  THEME_SATURATION_MIN,
  type ThemePreference,
} from "../../lib/appearance";
import { Row, Segmented, Toggle } from "../settingsBits";

export type AppearanceSettings = ReturnType<typeof useAppearanceSettings>;

export function useAppearanceSettings() {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(loadThemePreference);
  const [opacity, setOpacity] = useState(loadSidebarOpacity);
  const [themeHue, setThemeHue] = useState(loadThemeHue);
  const [themeSaturation, setThemeSaturation] = useState(loadThemeSaturation);
  const [bodyGlass, setBodyGlass] = useState(loadBodyGlass);
  const [glass, setGlass] = useState(loadGlass);

  const onThemePreference = useCallback((next: ThemePreference) => {
    applyThemePreference(next);
    saveThemePreference(next);
    setThemePreference(next);
  }, []);

  const onOpacity = useCallback((percent: number) => {
    const next = applySidebarOpacity(percent / 100);
    saveSidebarOpacity(next);
    setOpacity(next);
  }, []);

  const onTint = useCallback((hue: number, saturation: number) => {
    const next = applyThemeTint(hue, saturation);
    saveThemeHue(next.hue);
    saveThemeSaturation(next.saturation);
    setThemeHue(next.hue);
    setThemeSaturation(next.saturation);
  }, []);

  const onBodyGlass = useCallback((next: boolean) => {
    applyBodyGlass(next);
    saveBodyGlass(next);
    setBodyGlass(next);
  }, []);

  const onGlass = useCallback((next: boolean) => {
    applyGlass(next);
    saveGlass(next);
    setGlass(next);
  }, []);

  const restoreDefaults = useCallback(() => {
    onThemePreference(THEME_PREFERENCE_DEFAULT);
    onGlass(GLASS_DEFAULT);
    onOpacity(Math.round(SIDEBAR_OPACITY_DEFAULT * 100));
    onTint(THEME_HUE_DEFAULT, THEME_SATURATION_DEFAULT);
    onBodyGlass(BODY_GLASS_DEFAULT);
  }, [onBodyGlass, onGlass, onThemePreference, onOpacity, onTint]);

  return {
    themePreference,
    glass,
    opacity,
    themeHue,
    themeSaturation,
    bodyGlass,
    onThemePreference,
    onGlass,
    onOpacity,
    onTint,
    onBodyGlass,
    restoreDefaults,
  };
}

export function AppearancePage({ appearance }: { appearance: AppearanceSettings }) {
  const percent = Math.round(appearance.opacity * 100);

  return (
    <>
      <Row
        label="Theme"
        description="System follows the OS appearance. Dark and light share the same tint, so the hue below applies to both."
      >
        <Segmented
          label="Theme"
          value={appearance.themePreference}
          options={[
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onChange={appearance.onThemePreference}
        />
      </Row>
      <Row
        label="Glass"
        description="Let the desktop show through the sidebar and the project rail. Turning it on takes effect after a relaunch."
      >
        <Toggle label="Glass" on={appearance.glass} onChange={appearance.onGlass} />
      </Row>
      <Row
        label="Sidebar opacity"
        description="How much of the desktop shows through the sidebar and the project rail."
      >
        <Slider
          label="Sidebar opacity"
          value={percent}
          display={`${percent}%`}
          min={Math.round(SIDEBAR_OPACITY_MIN * 100)}
          max={Math.round(SIDEBAR_OPACITY_MAX * 100)}
          onChange={appearance.onOpacity}
        />
      </Row>
      <Row label="Hue" description="Base hue for accents and tinted surfaces.">
        <Slider
          label="Hue"
          value={appearance.themeHue}
          display={`${appearance.themeHue}°`}
          min={THEME_HUE_MIN}
          max={THEME_HUE_MAX}
          onChange={(value) =>
            appearance.onTint(value, appearance.themeSaturation)
          }
        />
      </Row>
      <Row
        label="Saturation"
        description="How strongly the hue tints the interface. Zero keeps it neutral."
      >
        <Slider
          label="Saturation"
          value={appearance.themeSaturation}
          display={`${appearance.themeSaturation}%`}
          min={THEME_SATURATION_MIN}
          max={THEME_SATURATION_MAX}
          onChange={(value) => appearance.onTint(appearance.themeHue, value)}
        />
      </Row>
      <Row
        label="Main pane glass"
        description="Extend the translucent treatment to the main pane behind sessions and editors."
      >
        <Toggle
          label="Main pane glass"
          on={appearance.bodyGlass}
          onChange={appearance.onBodyGlass}
        />
      </Row>
    </>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-56 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        className="sidebar-opacity-slider min-w-0 flex-1"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 shrink-0 text-right text-[12px] text-content tabular-nums">
        {display}
      </span>
    </div>
  );
}
