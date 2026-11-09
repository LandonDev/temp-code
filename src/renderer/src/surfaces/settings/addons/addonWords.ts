import { andList, grantFieldNames, scopeWords } from "@shared/addons";
import { SIGNIN_STEP_WORDS } from "@shared/addonGrantWords";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonAuth, AddonInput, AddonPlatform, AddonRow, AddonSpec, AddonStatus } from "@shared/contract-addons";
import type { MenuRow } from "../../../chrome/menuRows";
import type { ThreadState } from "../../../components/ui/status";

/**
 * Settings → Add-ons in words (docs/LAYOUT.md "Settings → Add-ons and
 * Skills"): a row's status mark, its facts, its menu, and the form's fields
 * to and from an `AddonSpec`. Pure: the page and its dialogs read these, and
 * every word the page says that no shared module has lives here.
 */

/** A grant as the page knows it: a view, `null` when the host holds nothing
 *  for the add-on (the list names only add-ons with values or a sign-in),
 *  `undefined` while the grants are unread. */
export type GrantKnown = AddonGrantView | null | undefined;

export type AddonMark = { state: ThreadState; word: string; detail?: string };

const tools = (n: number): string => (n === 1 ? "1 tool" : `${n} tools`);

/** "Mac only" or "Linux only" for an add-on limited to one kind of host; null for every host. */
function onlyOn(platforms: readonly AddonPlatform[] | undefined, words: { darwin: string; linux: string }): string | null {
  if (!platforms || platforms.length !== 1) return null;
  return platforms[0] === "darwin" ? words.darwin : words.linux;
}

/** Whether the add-on waits on a sign-in rather than a value: the grant's gaps once read, else its auth. */
function needsSignIn(spec: AddonSpec, grant: GrantKnown): boolean {
  if (grant) return grant.gaps.includes("sign-in") || grant.oauth?.refused === true;
  return spec.auth === "oauth";
}

/**
 * The row's second line, in the Hosts page's way (`linkMarkOf`): a sign-in in
 * flight first, then Off for a disabled row, then the host's state of the
 * add-on. A needs-grant detail is the host's own words unless they only
 * restate the word ("Needs values for …"), then the missing names once known.
 */
export function addonMark(row: AddonRow, status: AddonStatus | undefined, grant: GrantKnown): AddonMark {
  const signIn = grant?.signIn;
  if (signIn && signIn.state !== "failed") return { state: "working", word: "Signing in", detail: SIGNIN_STEP_WORDS[signIn.state] };
  if (!row.enabled) return { state: "idle", word: "Off" };
  if (!status) return { state: "working", word: "Starting" };
  switch (status.state) {
    case "off":
      return { state: "idle", word: "Off" };
    case "starting":
      return { state: "working", word: "Starting" };
    case "ready":
      // The host's own words when it cut the list ("12 of 300 tools listed").
      return { state: "done", word: "Connected", detail: status.detail || tools(status.tools) };
    case "failed":
      return status.detail ? { state: "failed", word: "Failed", detail: status.detail } : { state: "failed", word: "Failed" };
    case "needs-grant": {
      const word = needsSignIn(row.spec, grant) ? "Sign in needed" : "Needs a key";
      const own = status.detail && !status.detail.startsWith("Needs ") ? status.detail : null;
      // Read and absent from the list: nothing is saved, so every value it names is missing.
      const missing = grant ? grant.fields.filter((f) => !f.set).map((f) => f.name) : grant === null ? grantFieldNames(row.spec) : [];
      const detail = own ?? (missing.length ? andList(missing) : null);
      return detail ? { state: "waiting", word, detail } : { state: "waiting", word };
    }
    case "other-platform":
      return { state: "idle", word: onlyOn(row.spec.platforms, { darwin: "Mac only", linux: "Linux only" }) ?? "Not on this host" };
  }
}

/** The grant's facts: the names holding a value ("GITHUB_TOKEN saved"), "signed in", who refreshes it. Nothing for an add-on with no grant, nothing saved, or grants unread. */
export function grantFact(spec: AddonSpec, grant: GrantKnown): string[] {
  if (spec.auth === "none" || !grant) return [];
  const saved = grant.fields.filter((f) => f.set).map((f) => f.name);
  const out: string[] = [];
  if (saved.length) out.push(`${andList(saved)} saved`);
  if (grant.oauth?.signedIn) {
    out.push("signed in");
    if (grant.oauth.refreshedBy) out.push(`refreshed on ${grant.oauth.refreshedBy}`);
  }
  return out;
}

/** A scope's name: the workspace's, null for every workspace, or "A removed workspace" for an id this host no longer lists. */
export function scopeName(workspaceId: string | null, names: ReadonlyMap<string, string>): string | null {
  if (workspaceId === null) return null;
  return names.get(workspaceId) ?? "A removed workspace";
}

/** The row's third line: where it applies, the hosts it runs on (unless line two says so), its grant, the thread that wrote it. */
export function addonFacts(row: AddonRow, mark: AddonMark, grant: GrantKnown, workspaceName: string | null): string[] {
  const platform = onlyOn(row.spec.platforms, { darwin: "Macs only", linux: "Linux hosts only" });
  const saysPlatform = mark.word === "Mac only" || mark.word === "Linux only";
  return [
    scopeWords(workspaceName),
    ...(platform && !saysPlatform ? [platform] : []),
    ...grantFact(row.spec, grant),
    ...(row.writtenBy.kind === "thread" ? [`written by ${row.writtenBy.title || "a thread"}`] : []),
  ];
}

export type AddonMenuPick = "edit" | "key" | "signin" | "cancel-signin" | "signout" | "remove";

/**
 * The row's ⋯: Edit…, Add key… (Change key… once a value is saved) when the
 * spec names values, Sign in… for an http OAuth add-on in the desktop app
 * (Sign in again… once signed in or refused, Cancel sign-in while one runs),
 * Sign out while an OAuth grant holds a client or a sign-in, then Remove….
 * `unread` is why the grants are not known yet ("Loading"): the grant rows
 * stay, disabled with it as their reason.
 */
export function addonMenuRows(row: AddonRow, grant: GrantKnown, opts: { web: boolean; unread?: string }): MenuRow[] {
  const { spec } = row;
  const unread = opts.unread;
  const off = unread ? { disabled: true, reason: unread } : {};
  const rows: MenuRow[] = [{ kind: "item", id: "edit", label: "Edit…" }];
  if (grantFieldNames(spec).length) {
    const saved = grant?.fields.some((f) => f.set) ?? false;
    rows.push({ kind: "item", id: "key", label: saved ? "Change key…" : "Add key…", ...off });
  }
  if (spec.auth === "oauth" && spec.transport === "http" && !opts.web) {
    const running = grant?.signIn && grant.signIn.state !== "failed";
    if (running) rows.push({ kind: "item", id: "cancel-signin", label: "Cancel sign-in", ...off });
    else rows.push({ kind: "item", id: "signin", label: grant?.oauth?.signedIn || grant?.oauth?.refused ? "Sign in again…" : "Sign in…", ...off });
  }
  if (spec.auth === "oauth" && (unread || grant?.oauth)) rows.push({ kind: "item", id: "signout", label: "Sign out", ...off });
  rows.push({ kind: "sep" }, { kind: "item", id: "remove", label: "Remove…", danger: true });
  return rows;
}

// ── the form ────────────────────────────────────────────────────────────

export type AddonHosts = "all" | AddonPlatform;

/** Add… and Edit…'s fields, as the person types them. */
export interface AddonForm {
  name: string;
  description: string;
  workspaceId: string | null;
  transport: "stdio" | "http";
  command: string;
  /** one argument a line */
  args: string;
  /** variable names, split on spaces and commas */
  env: string;
  tokenEnv: string;
  url: string;
  /** header names, split the same way */
  headers: string;
  auth: AddonAuth;
  hosts: AddonHosts;
}

/** One argument a line; empty lines dropped. */
export const argLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Names split on spaces and commas. */
export const nameList = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

/** A new form, or a row's own to edit. */
export function formOf(row: AddonRow | null, workspaceId: string | null = null): AddonForm {
  if (!row) {
    return { name: "", description: "", workspaceId, transport: "stdio", command: "", args: "", env: "", tokenEnv: "", url: "", headers: "", auth: "none", hosts: "all" };
  }
  const { spec } = row;
  return {
    name: row.name,
    description: row.description,
    workspaceId: row.workspaceId,
    transport: spec.transport,
    command: spec.transport === "stdio" ? spec.command : "",
    args: spec.transport === "stdio" ? spec.args.join("\n") : "",
    env: spec.transport === "stdio" ? spec.env.join(" ") : "",
    tokenEnv: spec.transport === "stdio" ? (spec.tokenEnv ?? "") : "",
    url: spec.transport === "http" ? spec.url : "",
    headers: spec.transport === "http" ? spec.headers.join(" ") : "",
    auth: spec.auth,
    hosts: spec.platforms?.length === 1 ? spec.platforms[0]! : "all",
  };
}

/** The form as the spec `addons.set` takes. A command signs in only with a token variable (a thread's row keeps it). */
export function specOf(form: AddonForm): AddonSpec {
  const platforms = form.hosts === "all" ? {} : { platforms: [form.hosts] };
  if (form.transport === "stdio") {
    const tokenEnv = form.auth === "oauth" && form.tokenEnv.trim() ? { tokenEnv: form.tokenEnv.trim() } : {};
    return { transport: "stdio", command: form.command.trim(), args: argLines(form.args), env: nameList(form.env), auth: form.auth, ...tokenEnv, ...platforms };
  }
  return { transport: "http", url: form.url.trim(), headers: nameList(form.headers), auth: form.auth, ...platforms };
}

/** What Save sends: the row's id and on/off for an edit, a fresh id for a new add-on. */
export function inputOf(form: AddonForm, row: AddonRow | null): AddonInput {
  return {
    id: row?.id ?? newAddonId(),
    name: form.name.trim(),
    workspaceId: form.workspaceId,
    description: form.description.trim(),
    spec: specOf(form),
    enabled: row?.enabled ?? true,
  };
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * A fresh row id, `ad_` and 12 URL-safe characters, as the store mints them.
 * A new add-on always sends one: without an id `addons.set` replaces the row
 * of that scope and name, while a new id makes a taken name a refusal.
 */
export function newAddonId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ad_${Array.from(bytes, (b) => ID_ALPHABET[b & 63]).join("")}`;
}

/** The field-name rule's words under Name. */
export const NAME_RULE = "Lowercase letters, digits and dashes, 20 at most";
/** Sign in on a command: there is no address to sign in at. */
export const COMMAND_NO_SIGNIN = "A command has no address to sign in at";
