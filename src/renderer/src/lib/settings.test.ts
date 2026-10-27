import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_RUNNER_DEFAULT,
  GRID_ARCADE_ENABLED_DEFAULT,
  filterKeybindings,
  isSettingsSectionId,
  KEYBINDING_GROUPS,
  KEYBINDING_SCOPE_LABEL,
  loadSettingsSection,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsSectionLabel,
  LIVE_AGENTS_ENABLED_DEFAULT,
  loadComposerRunner,
  loadGridArcadeEnabled,
  loadLiveAgentsEnabled,
  loadMidTurnDefault,
  loadNotesEnabled,
  MID_TURN_DEFAULT,
  NOTES_ENABLED_DEFAULT,
  saveComposerRunner,
  saveGridArcadeEnabled,
  saveLiveAgentsEnabled,
  saveMidTurnDefault,
  saveNotesEnabled,
} from "./settings";

const KEY = "monocode.composerRunner";
const NOTES_KEY = "monocode.notesEnabled";
const LIVE_AGENTS_KEY = "monocode.liveAgentsEnabled";
const GRID_ARCADE_KEY = "monocode.gridArcadeEnabled";

function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("composer runner setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(KEY);
  });

  it("defaults to on", () => {
    expect(COMPOSER_RUNNER_DEFAULT).toBe(true);
    expect(loadComposerRunner()).toBe(true);
  });

  it("persists an off switch", () => {
    saveComposerRunner(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(loadComposerRunner()).toBe(false);
    saveComposerRunner(true);
    expect(loadComposerRunner()).toBe(true);
  });
});

describe("notes enabled setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(NOTES_KEY);
  });

  it("defaults to on", () => {
    expect(NOTES_ENABLED_DEFAULT).toBe(true);
    expect(loadNotesEnabled()).toBe(true);
  });

  it("persists an off switch", () => {
    saveNotesEnabled(false);
    expect(localStorage.getItem(NOTES_KEY)).toBe("0");
    expect(loadNotesEnabled()).toBe(false);
    saveNotesEnabled(true);
    expect(loadNotesEnabled()).toBe(true);
  });
});

describe("live agents enabled setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(LIVE_AGENTS_KEY);
  });

  it("defaults to on", () => {
    expect(LIVE_AGENTS_ENABLED_DEFAULT).toBe(true);
    expect(loadLiveAgentsEnabled()).toBe(true);
  });

  it("persists an off switch", () => {
    saveLiveAgentsEnabled(false);
    expect(localStorage.getItem(LIVE_AGENTS_KEY)).toBe("0");
    expect(loadLiveAgentsEnabled()).toBe(false);
    saveLiveAgentsEnabled(true);
    expect(loadLiveAgentsEnabled()).toBe(true);
  });
});

describe("grid arcade enabled setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(GRID_ARCADE_KEY);
  });

  it("defaults to on", () => {
    expect(GRID_ARCADE_ENABLED_DEFAULT).toBe(true);
    expect(loadGridArcadeEnabled()).toBe(true);
  });

  it("persists an off switch", () => {
    saveGridArcadeEnabled(false);
    expect(localStorage.getItem(GRID_ARCADE_KEY)).toBe("0");
    expect(loadGridArcadeEnabled()).toBe(false);
    saveGridArcadeEnabled(true);
    expect(loadGridArcadeEnabled()).toBe(true);
  });
});

describe("settings sections", () => {
  it("puts every section in exactly one known group", () => {
    const groups = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const section of SETTINGS_SECTIONS) expect(groups.has(section.group)).toBe(true);
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists each group's pages together, in the groups' order", () => {
    const order = SETTINGS_SECTIONS.map((section) => SETTINGS_GROUPS.findIndex((group) => group.id === section.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names the remote page Hosts", () => {
    expect(settingsSectionLabel("remote")).toBe("Hosts");
  });

  it("loads a saved environments page as Hosts", () => {
    mockLocalStorage();
    localStorage.setItem("monocode.settingsSection", "environments");
    expect(loadSettingsSection()).toBe("remote");
    expect(isSettingsSectionId("environments")).toBe(false);
  });

  it("has no Build page; a saved one loads as the default", () => {
    expect(SETTINGS_SECTIONS.some((section) => (section.id as string) === "build")).toBe(false);
    mockLocalStorage();
    localStorage.setItem("monocode.settingsSection", "build");
    expect(loadSettingsSection()).toBe("general");
  });
});

describe("keybindings", () => {
  const all = KEYBINDING_GROUPS.flatMap((group) => group.bindings);

  it("gives every binding at least one chord of caps", () => {
    for (const binding of all) {
      expect(binding.keys.length).toBeGreaterThan(0);
      for (const chord of binding.keys) {
        expect(chord.length).toBeGreaterThan(0);
        for (const cap of chord) expect(cap).not.toMatch(/\+$/);
      }
    }
  });

  it("says where a binding holds in words, never code", () => {
    for (const binding of all) {
      if (binding.scope) expect(KEYBINDING_SCOPE_LABEL[binding.scope]).toMatch(/^[A-Z][a-z ]+$/);
    }
    expect(JSON.stringify(KEYBINDING_GROUPS)).not.toMatch(/editorFocus|deckLayout|Always/);
  });

  it("filters by name, by group and by keys", () => {
    expect(filterKeybindings(KEYBINDING_GROUPS, "symbol").flatMap((g) => g.bindings.map((b) => b.name))).toEqual([
      "Go to Symbol",
    ]);
    expect(filterKeybindings(KEYBINDING_GROUPS, "terminal").map((g) => g.title)).toEqual(["Terminal"]);
    const byKeys = filterKeybindings(KEYBINDING_GROUPS, "ctrl k").flatMap((g) => g.bindings.map((b) => b.name));
    const byGlyph = filterKeybindings(KEYBINDING_GROUPS, "⌘K").flatMap((g) => g.bindings.map((b) => b.name));
    expect([...byKeys, ...byGlyph]).toContain("Search");
    expect(filterKeybindings(KEYBINDING_GROUPS, "nothing like this")).toEqual([]);
  });
});

describe("mid-turn default", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("is steer: a follow-up reaches the running turn", () => {
    expect(MID_TURN_DEFAULT).toBe("steer");
    expect(loadMidTurnDefault()).toBe("steer");
  });

  it("a stored preference wins either way", () => {
    saveMidTurnDefault("queue");
    expect(loadMidTurnDefault()).toBe("queue");
    saveMidTurnDefault("steer");
    expect(loadMidTurnDefault()).toBe("steer");
    localStorage.setItem("monocode.midTurnDefault", "nonsense");
    expect(loadMidTurnDefault()).toBe("steer");
  });
});
