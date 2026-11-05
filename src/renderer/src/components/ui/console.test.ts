import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLE } from "./console";

const src = resolve(__dirname, "../..");

describe("the console recipe", () => {
  it("is the card fill, 12 by 8 inside an 8px radius, 12px mono on 20px lines, with the focus ring", () => {
    for (const cls of ["rounded-lg", "bg-card", "px-3", "py-2", "font-mono", "text-xs", "leading-5", "text-muted-foreground", "focus-ring"]) {
      expect(CONSOLE.split(" ")).toContain(cls);
    }
  });

  it("is what the batch step's console, a job's log and the licence draw, each reachable by the keyboard", () => {
    for (const file of ["surfaces/threads/master/BatchFoot.tsx", "surfaces/settings/hosts/JobLog.tsx", "surfaces/settings/Editor.tsx"]) {
      const text = readFileSync(resolve(src, file), "utf8");
      expect(text, file).toContain("cn(CONSOLE,");
      expect(text, file).toMatch(/tabIndex=\{0\}[\s\S]{0,80}cn\(CONSOLE,|cn\(CONSOLE,[\s\S]{0,200}tabIndex=\{0\}|<pre tabIndex=\{0\} className=\{cn\(CONSOLE/);
    }
  });
});

describe("red in rows", () => {
  it("a row's remove, stop or revoke is a ghost that turns red on hover; solid red stays in confirms", () => {
    for (const file of ["surfaces/settings/hosts/JobLog.tsx", "surfaces/settings/hosts/Devices.tsx", "surfaces/settings/hosts/MacBridgeHostDialog.tsx", "surfaces/settings/hosts/Clients.tsx"]) {
      const text = readFileSync(resolve(src, file), "utf8");
      expect(text, file).not.toContain('variant="destructive"');
      expect(text, file).toContain("hover:text-destructive");
    }
  });

  it("Cancel is secondary in every dialog footer", () => {
    // A footer drawn by hand writes its Cancel; the shared DialogFooter draws one for its onCancel.
    const secondaryCancel = (file: string, text: string) => {
      const at = text.search(/>\s*Cancel\s*<\/Button>/);
      expect(at, file).toBeGreaterThan(0);
      expect(text.slice(text.lastIndexOf("<Button", at), at), file).toContain('variant="secondary"');
    };
    secondaryCancel("chrome/ConfirmDialog.tsx", readFileSync(resolve(src, "chrome/ConfirmDialog.tsx"), "utf8"));
    for (const file of ["chrome/SwitchBranchDialog.tsx", "chrome/OrchestrationRules.tsx", "aliax/views/edit-account-dialog.tsx", "aliax/pages.tsx"]) {
      const text = readFileSync(resolve(src, file), "utf8");
      if (/<DialogFooter\b/.test(text) && /\bonCancel=/.test(text) && !/>\s*Cancel\s*<\/Button>/.test(text)) continue;
      secondaryCancel(file, text);
    }
  });
});
