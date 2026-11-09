import { describe, expect, it } from "vitest";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonSpec, AddonStatus } from "@shared/contract-addons";
import { addonFacts, addonMark, addonMenuRows, argLines, formOf, grantFact, inputOf, nameList, newAddonId, scopeName, specOf, type AddonForm } from "./addonWords";

const stdio: AddonSpec = { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"], auth: "fields" };
const http: AddonSpec = { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], auth: "oauth" };

const row = (over: Partial<AddonRow> = {}): AddonRow => ({
  id: "ad_github000001",
  name: "github",
  workspaceId: null,
  description: "",
  spec: stdio,
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const status = (state: AddonStatus["state"], over: Partial<AddonStatus> = {}): AddonStatus => ({ state, tools: 0, at: 1, ...over });
const grant = (over: Partial<AddonGrantView> = {}): AddonGrantView => ({ addonId: "ad_github000001", fields: [], oauth: null, signIn: null, gaps: [], ...over });

describe("addonMark", () => {
  it("says a sign-in in flight first, by its step", () => {
    const g = grant({ signIn: { state: "waiting", since: 1 } });
    expect(addonMark(row({ enabled: false }), status("ready", { tools: 3 }), g)).toEqual({ state: "working", word: "Signing in", detail: "Waiting for the browser" });
    // A failed sign-in is the row's error, not its mark.
    expect(addonMark(row(), status("ready", { tools: 3 }), grant({ signIn: { state: "failed", since: 1, error: "x" } })).word).toBe("Connected");
  });

  it("reads Off for a disabled row whatever the host says, Starting before the host says anything", () => {
    expect(addonMark(row({ enabled: false }), status("ready", { tools: 3 }), null)).toEqual({ state: "idle", word: "Off" });
    expect(addonMark(row(), undefined, null)).toEqual({ state: "working", word: "Starting" });
  });

  it("follows the host's state", () => {
    expect(addonMark(row(), status("off"), null)).toEqual({ state: "idle", word: "Off" });
    expect(addonMark(row(), status("starting"), null)).toEqual({ state: "working", word: "Starting" });
    expect(addonMark(row(), status("ready", { tools: 1 }), null)).toEqual({ state: "done", word: "Connected", detail: "1 tool" });
    expect(addonMark(row(), status("ready", { tools: 24 }), null)).toEqual({ state: "done", word: "Connected", detail: "24 tools" });
    expect(addonMark(row(), status("ready", { tools: 12, detail: "12 of 300 tools listed" }), null).detail).toBe("12 of 300 tools listed");
    expect(addonMark(row(), status("failed", { detail: "Exited (code 3): no such file" }), null)).toEqual({
      state: "failed",
      word: "Failed",
      detail: "Exited (code 3): no such file",
    });
    expect(addonMark(row({ spec: { ...stdio, platforms: ["darwin"] } }), status("other-platform"), null)).toEqual({ state: "idle", word: "Mac only" });
    expect(addonMark(row({ spec: { ...stdio, platforms: ["linux"] } }), status("other-platform"), null)).toEqual({ state: "idle", word: "Linux only" });
  });

  it("says what a needs-grant row waits for, never repeating Needs", () => {
    const needs = status("needs-grant", { detail: "Needs values for GITHUB_TOKEN" });
    // Unread grants: the spec's auth decides, and the host's "Needs …" is not repeated.
    expect(addonMark(row(), needs, undefined)).toEqual({ state: "waiting", word: "Needs a key" });
    expect(addonMark(row({ spec: http }), status("needs-grant", { detail: "Needs a sign-in on the Mac" }), undefined)).toEqual({ state: "waiting", word: "Sign in needed" });
    // Read with nothing saved: every value the spec names.
    expect(addonMark(row(), needs, null)).toEqual({ state: "waiting", word: "Needs a key", detail: "GITHUB_TOKEN" });
    // Read: the missing names.
    expect(addonMark(row(), needs, grant({ fields: [{ name: "GITHUB_TOKEN", set: false }], gaps: ["GITHUB_TOKEN"] }))).toEqual({
      state: "waiting",
      word: "Needs a key",
      detail: "GITHUB_TOKEN",
    });
    // A refused OAuth grant reads Sign in needed, with the host's own words.
    const refused = grant({ oauth: { signedIn: true, expiresAt: null, refreshedBy: null, refused: true } });
    expect(addonMark(row({ spec: http }), status("needs-grant", { detail: "The server refused the grant" }), refused)).toEqual({
      state: "waiting",
      word: "Sign in needed",
      detail: "The server refused the grant",
    });
    expect(addonMark(row({ spec: http }), status("needs-grant"), grant({ gaps: ["sign-in"] })).word).toBe("Sign in needed");
  });
});

describe("grantFact", () => {
  it("says nothing for no auth, no grant or unread grants", () => {
    expect(grantFact({ ...stdio, auth: "none", env: [] }, grant())).toEqual([]);
    expect(grantFact(stdio, null)).toEqual([]);
    expect(grantFact(stdio, undefined)).toEqual([]);
  });

  it("names the values held, all or some", () => {
    expect(grantFact(stdio, grant({ fields: [{ name: "GITHUB_TOKEN", set: true }] }))).toEqual(["GITHUB_TOKEN saved"]);
    const two: AddonSpec = { transport: "http", url: "https://x.example/mcp", headers: ["X-Api-Key", "X-Org", "X-Team"], auth: "fields" };
    expect(grantFact(two, grant({ fields: [{ name: "X-Api-Key", set: true }, { name: "X-Org", set: true }, { name: "X-Team", set: false }] }))).toEqual(["X-Api-Key and X-Org saved"]);
    expect(grantFact(stdio, grant({ fields: [{ name: "GITHUB_TOKEN", set: false }] }))).toEqual([]);
  });

  it("says signed in, and the host that refreshes it", () => {
    expect(grantFact(http, grant({ oauth: { signedIn: true, expiresAt: null, refreshedBy: null, refused: false } }))).toEqual(["signed in"]);
    expect(grantFact(http, grant({ oauth: { signedIn: true, expiresAt: null, refreshedBy: "box", refused: false } }))).toEqual(["signed in", "refreshed on box"]);
  });
});

describe("addonFacts", () => {
  it("says the scope, the hosts unless line two does, the grant and a thread writer", () => {
    const r = row({ spec: { ...stdio, platforms: ["darwin"] }, writtenBy: { kind: "thread", sessionId: "s", environmentId: "e", title: "Fix the build" } });
    const g = grant({ fields: [{ name: "GITHUB_TOKEN", set: true }] });
    expect(addonFacts(r, addonMark(r, status("ready", { tools: 2 }), g), g, null)).toEqual(["Every workspace", "Macs only", "GITHUB_TOKEN saved", "written by Fix the build"]);
    expect(addonFacts(r, addonMark(r, status("other-platform"), g), g, "temp-code")).toEqual(["temp-code", "GITHUB_TOKEN saved", "written by Fix the build"]);
  });

  it("names no writer but a thread", () => {
    const r = row({ writtenBy: { kind: "person", key: "Phone" } });
    expect(addonFacts(r, addonMark(r, status("off"), null), null, null)).toEqual(["Every workspace"]);
    const imported = row({ writtenBy: { kind: "import", from: "~/.claude.json" } });
    expect(addonFacts(imported, addonMark(imported, status("off"), null), null, null)).toEqual(["Every workspace"]);
  });

  it("names a workspace this host lists, and one it no longer does", () => {
    const names = new Map([["ws_1", "temp-code"]]);
    expect(scopeName(null, names)).toBeNull();
    expect(scopeName("ws_1", names)).toBe("temp-code");
    expect(scopeName("ws_gone", names)).toBe("A removed workspace");
  });
});

describe("addonMenuRows", () => {
  const items = (rows: ReturnType<typeof addonMenuRows>) =>
    rows.map((r) => (r.kind === "item" ? `${r.label}${r.disabled ? ` (${r.reason})` : ""}${r.danger ? " danger" : ""}` : r.kind));

  it("offers the key only when the spec names values, Change key once one is saved", () => {
    expect(items(addonMenuRows(row(), null, { web: false }))).toEqual(["Edit…", "Add key…", "sep", "Remove… danger"]);
    expect(items(addonMenuRows(row(), grant({ fields: [{ name: "GITHUB_TOKEN", set: true }] }), { web: false }))).toEqual(["Edit…", "Change key…", "sep", "Remove… danger"]);
    expect(items(addonMenuRows(row({ spec: { ...stdio, env: [], auth: "none" } }), null, { web: false }))).toEqual(["Edit…", "sep", "Remove… danger"]);
  });

  it("disables the grant rows while the grants are unread", () => {
    expect(items(addonMenuRows(row(), undefined, { web: false, unread: "Loading" }))).toEqual(["Edit…", "Add key… (Loading)", "sep", "Remove… danger"]);
    expect(items(addonMenuRows(row({ spec: http }), undefined, { web: false, unread: "Loading" }))).toEqual(["Edit…", "Sign in… (Loading)", "Sign out (Loading)", "sep", "Remove… danger"]);
  });

  it("offers Sign in on the desktop for an http OAuth add-on, again once signed in or refused, Cancel while one runs", () => {
    expect(items(addonMenuRows(row({ spec: http }), null, { web: false }))).toEqual(["Edit…", "Sign in…", "sep", "Remove… danger"]);
    const signedIn = grant({ oauth: { signedIn: true, expiresAt: null, refreshedBy: null, refused: false } });
    expect(items(addonMenuRows(row({ spec: http }), signedIn, { web: false }))).toEqual(["Edit…", "Sign in again…", "Sign out", "sep", "Remove… danger"]);
    const refused = grant({ oauth: { signedIn: false, expiresAt: null, refreshedBy: null, refused: true } });
    expect(items(addonMenuRows(row({ spec: http }), refused, { web: false }))).toEqual(["Edit…", "Sign in again…", "Sign out", "sep", "Remove… danger"]);
    const running = grant({ signIn: { state: "waiting", since: 1 } });
    expect(items(addonMenuRows(row({ spec: http }), running, { web: false }))).toEqual(["Edit…", "Cancel sign-in", "sep", "Remove… danger"]);
  });

  it("never offers Sign in at /ui, Sign out there all the same", () => {
    const signedIn = grant({ oauth: { signedIn: true, expiresAt: null, refreshedBy: "box", refused: false } });
    expect(items(addonMenuRows(row({ spec: http }), signedIn, { web: true }))).toEqual(["Edit…", "Sign out", "sep", "Remove… danger"]);
    // A stdio OAuth add-on (a thread's) signs out but never signs in here.
    const stdioOauth: AddonSpec = { ...stdio, env: [], auth: "oauth", tokenEnv: "TOKEN" };
    expect(items(addonMenuRows(row({ spec: stdioOauth }), signedIn, { web: false }))).toEqual(["Edit…", "Sign out", "sep", "Remove… danger"]);
  });
});

describe("the form", () => {
  it("mints ad_ and 12 URL-safe characters, fresh each time", () => {
    const id = newAddonId();
    expect(id).toMatch(/^ad_[A-Za-z0-9_-]{12}$/);
    expect(newAddonId()).not.toBe(id);
  });

  it("parses argument lines and names", () => {
    expect(argLines("-y\n\n  @scope/server  \r\n--flag\n")).toEqual(["-y", "@scope/server", "--flag"]);
    expect(nameList("X-Api-Key, X-Org  X-Team,")).toEqual(["X-Api-Key", "X-Org", "X-Team"]);
    expect(nameList("  ")).toEqual([]);
  });

  const roundTrip = (spec: AddonSpec) => expect(specOf(formOf(row({ spec })))).toEqual(spec);

  it("round-trips a command and an address, every auth and every hosts choice", () => {
    roundTrip(stdio);
    roundTrip({ ...stdio, env: [], auth: "none" });
    roundTrip({ ...stdio, env: ["A"], auth: "oauth", tokenEnv: "TOKEN" });
    roundTrip({ ...stdio, platforms: ["darwin"] });
    roundTrip(http);
    roundTrip({ ...http, auth: "fields", headers: ["X-Api-Key"] });
    roundTrip({ ...http, auth: "none", platforms: ["linux"] });
  });

  it("leaves the token variable out unless a command signs in", () => {
    const form: AddonForm = { ...formOf(null), command: "srv", tokenEnv: "TOKEN", auth: "fields", env: "A" };
    expect(specOf(form)).toEqual({ transport: "stdio", command: "srv", args: [], env: ["A"], auth: "fields" });
  });

  it("sends a fresh id for a new add-on, the row's id and on/off for an edit", () => {
    const fresh = inputOf({ ...formOf(null), name: " github ", command: "npx" }, null);
    expect(fresh.id).toMatch(/^ad_/);
    expect(fresh).toMatchObject({ name: "github", workspaceId: null, enabled: true, description: "" });
    const r = row({ enabled: false, workspaceId: "ws_1" });
    expect(inputOf(formOf(r), r)).toEqual({ id: r.id, name: "github", workspaceId: "ws_1", description: "", spec: stdio, enabled: false });
  });
});
