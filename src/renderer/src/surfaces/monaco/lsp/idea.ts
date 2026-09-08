import type { ProjectMeta } from "../../../lib/tcserver/types";
import { dirPrefix, projectForCwd } from "../../../lib/tcserver/projects";
import { monaco } from "../monaco";
import { entryForUri, openFile, type OpenedFile } from "../models";
import { conns, ensureConnection, settledIdea, type LspConnection } from "./connection";
import { IDEA_LANGS, kindForLanguage } from "./types";

/**
 * The IntelliJ engine race. jdtls is always in flight; IDEA is only ever a
 * better answer that arrives in time. Health: 2 consecutive timeouts or
 * errors park the race (zero per-keystroke overhead); a 10 s probe with 2
 * consecutive hits restores it. Legit empty lists fall back but are not
 * health strikes.
 */

export const IDEA_BUDGET_MS = 300;
const ideaHealth = new Map<string, { misses: number; hits: number; lastProbe: number }>();

export function ideaEligible(projectId: string): boolean {
  const h = ideaHealth.get(projectId);
  if (!h || h.misses < 2) return true;
  return Date.now() - h.lastProbe > 10_000;
}

export function recordIdea(projectId: string, ok: boolean): void {
  const h = ideaHealth.get(projectId) ?? { misses: 0, hits: 0, lastProbe: 0 };
  h.lastProbe = Date.now();
  if (ok) {
    h.hits++;
    if (h.misses >= 2 && h.hits >= 2) h.misses = 0; // recovered
    else if (h.misses < 2) h.misses = 0;
  } else {
    h.misses++;
    h.hits = 0;
  }
  ideaHealth.set(projectId, h);
}

/** The server project a model belongs to, if any. */
export function projectForModel(model: monaco.editor.ITextModel): ProjectMeta | undefined {
  const entry = entryForUri(model.uri);
  if (!entry) return undefined;
  return projectForCwd(entry.cwd);
}

/** Called by the pane when a file mounts: boot the servers the model needs. */
export function ensureForModel(project: ProjectMeta, model: monaco.editor.ITextModel): void {
  const kind = kindForLanguage(model.getLanguageId());
  if (kind) void ensureConnection(project, kind).then((conn) => conn?.maybeOpen(model));
  // The IntelliJ engine starts importing the moment a Java or Kotlin file
  // mounts (kotlin's only server).
  if (IDEA_LANGS.has(model.getLanguageId())) {
    void ensureConnection(project, "java", "idea").then((conn) => conn?.maybeOpen(model));
  }
}

/** Connection that owns a model, if one is up. */
export async function connFor(model: monaco.editor.ITextModel): Promise<LspConnection | null> {
  const kind = kindForLanguage(model.getLanguageId());
  const project = projectForModel(model);
  if (!project || !kind) return null;
  const conn = await ensureConnection(project, kind);
  conn?.maybeOpen(model);
  return conn;
}

/** The alive-and-eligible IntelliJ connection for a model, if any. */
export function ideaFor(model: monaco.editor.ITextModel): LspConnection | null {
  if (!IDEA_LANGS.has(model.getLanguageId())) return null;
  const project = projectForModel(model);
  if (!project) return null;
  const ij = settledIdea.get(project.id);
  return ij?.alive && ideaEligible(project.id) ? ij : null;
}

/** Read-side routing: the IntelliJ engine answers when alive, eligible and
 *  capable; jdtls fills on miss or timeout. Web models never detour. */
export async function readSide<T>(
  model: monaco.editor.ITextModel,
  cap: string,
  method: string,
  params: unknown,
  budgetMs = 800,
): Promise<T | null> {
  const std = await connFor(model);
  const ij = ideaFor(model);
  if (ij?.capabilities[cap]) {
    ij.maybeOpen(model);
    // With a standard fallback the engine gets a budget; without one
    // (kotlin) it is the answer: wait it out.
    if (std?.capabilities[cap]) {
      const r = await Promise.race([
        ij.request<T>(method, params).catch(() => null),
        new Promise<"timeout">((res) => setTimeout(() => res("timeout"), budgetMs)),
      ]);
      if (r !== "timeout" && r !== null) return r;
    } else {
      return ij.request<T>(method, params).catch(() => null);
    }
  }
  if (!std?.capabilities[cap]) return null;
  return std.request<T>(method, params).catch(() => null);
}

/** The pending idea connection for a project, if one was ever asked for. */
export function ideaPending(projectId: string): Promise<LspConnection | null> | undefined {
  return conns.get(`${projectId}:idea`);
}

// ── preview models (peek / goto into unopened files) ─────────────────

const previews = new Map<string, OpenedFile>();
const PREVIEW_CAP = 30;

export async function ensurePreviewModel(project: ProjectMeta, uri: monaco.Uri): Promise<void> {
  if (monaco.editor.getModel(uri)) return;
  const root = dirPrefix(project.cwd);
  if (uri.scheme !== "file" || !uri.path.startsWith(root)) return;
  if (previews.has(uri.path)) return;
  try {
    const handle = await openFile(uri.path, project.cwd);
    if (!handle.model) return;
    previews.set(uri.path, handle);
    if (previews.size > PREVIEW_CAP) {
      const [oldKey, old] = previews.entries().next().value as [string, OpenedFile];
      previews.delete(oldKey);
      old.release();
    }
  } catch {
    // unreadable target: peek shows what it can
  }
}

// ── decompiled sources ───────────────────────────────────────────────
// Library navigation lands on jar: URIs; the engine's `decompile` command
// supplies the text and peek renders it like any model.

const decompiledModels = new Map<string, monaco.editor.ITextModel>();

export async function ensureDecompiledModel(projectId: string, rawUri: string): Promise<void> {
  const uri = monaco.Uri.parse(rawUri);
  if (monaco.editor.getModel(uri)) return;
  const ij = settledIdea.get(projectId);
  if (!ij?.alive) return;
  const res = await ij
    .request<{ code?: string } | null>("workspace/executeCommand", {
      command: "decompile",
      arguments: [rawUri],
    })
    .catch(() => null);
  if (!res?.code) return;
  decompiledModels.set(rawUri, monaco.editor.createModel(res.code, "java", uri));
  if (decompiledModels.size > 20) {
    const oldest = decompiledModels.entries().next().value as [string, monaco.editor.ITextModel];
    decompiledModels.delete(oldest[0]);
    oldest[1].dispose();
  }
}
