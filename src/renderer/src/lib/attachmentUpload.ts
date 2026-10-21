import { registry } from "./connection";
import type { Attachment } from "./session";
import type {
  AttachmentBeginAnswer,
  AttachmentDigest,
  AttachmentRange,
  AttachmentSettings,
  CommittedAttachment,
} from "@server/shared/contract-attachments";
import {
  ATTACHMENT_CHUNK_BYTES,
  DEFAULT_ATTACHMENT_MAX_BYTES,
} from "@server/shared/contract-attachments";

/**
 * Attachments on a remote thread (docs/box.md "Attachments on a remote
 * thread"). A file the composer holds lives on the host it came from (its
 * `environmentId`: the Mac's disk for a pick, a drop or an appshot) or only
 * in memory (a pasted blob too big to embed). A thread on another host
 * cannot read either, so before the turn is sent each such file is streamed
 * to the thread's host (`attachment.begin` → `chunk` × n → `commit`, each
 * chunk awaited: that is the backpressure) and the turn names the path it
 * landed at. A file already on the thread's host is sent by path, as before.
 */

export type UploadProgress = { sent: number; total: number };

/** A failure the composer shows on the file's chip; never a failed turn. */
export class AttachmentUploadError extends Error {
  constructor(
    readonly fileId: string,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

/** Whether `file` must be copied to `threadEnv` before a turn there can name it. */
export function needsUpload(file: Attachment, threadEnv: string): boolean {
  if (file.path) return !!file.environmentId && file.environmentId !== threadEnv;
  // A paste too big to embed is only in memory until it is uploaded.
  return !!file.blob && !file.data;
}

/** Whether `file` is a copy this host has to take (and so counts against its limit). */
export function copiesBytes(file: Attachment, threadEnv: string): boolean {
  return needsUpload(file, threadEnv) || (!file.path && !!file.blob);
}

const settingsCache = new Map<string, Promise<AttachmentSettings>>();

/** The thread host's per-file limit; the default when the host predates the setting. */
export function attachmentSettings(environmentId: string): Promise<AttachmentSettings> {
  let cached = settingsCache.get(environmentId);
  if (!cached) {
    cached = registry
      .linkOf(environmentId)
      .request<AttachmentSettings>("attachment.settings", {})
      .catch(() => {
        settingsCache.delete(environmentId);
        return { maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES, chunkBytes: ATTACHMENT_CHUNK_BYTES };
      });
    settingsCache.set(environmentId, cached);
  }
  return cached;
}

/** Forget a host's cached settings (after Settings changed the limit). */
export function forgetAttachmentSettings(environmentId?: string): void {
  if (environmentId) settingsCache.delete(environmentId);
  else settingsCache.clear();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function overLimitMessage(file: Pick<Attachment, "name" | "size">, maxBytes: number): string {
  return `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} limit for attachments to this host`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where the bytes come from: the kept Blob, or ranged reads on the origin host. */
type Source = {
  size: number;
  sha256: string;
  read(offset: number, length: number): Promise<string>;
};

async function blobSource(blob: Blob): Promise<Source> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return {
    size: blob.size,
    sha256: hex(digest),
    read: async (offset, length) =>
      bytesToBase64(new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())),
  };
}

async function hostSource(environmentId: string, path: string): Promise<Source> {
  const link = registry.linkOf(environmentId);
  const digest = await link.request<AttachmentDigest>("attachment.digest", { path });
  return {
    size: digest.size,
    sha256: digest.sha256,
    read: async (offset, length) =>
      (await link.request<AttachmentRange>("attachment.readRange", { path, offset, length })).dataBase64,
  };
}

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("bad request")) return "the thread's host is too old to take attachment uploads; update it";
  if (message.startsWith("forbidden")) return `the thread's host refused the upload (${message})`;
  return message;
}

/** Stream one file's bytes into `sessionId`'s attachment dir on `threadEnv`; answers the landed path. */
export async function uploadFile(opts: {
  threadEnv: string;
  sessionId: string;
  name: string;
  mime?: string;
  source: Source;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<CommittedAttachment> {
  const link = registry.linkOf(opts.threadEnv);
  const { size, sha256 } = opts.source;
  const begun = await link.request<AttachmentBeginAnswer>("attachment.begin", {
    sessionId: opts.sessionId,
    name: opts.name,
    size,
    sha256,
    ...(opts.mime ? { mime: opts.mime } : {}),
  });
  const chunk = Math.min(begun.chunkBytes || ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES);
  try {
    opts.onProgress?.({ sent: 0, total: size });
    for (let offset = 0, index = 0; offset < size; offset += chunk, index += 1) {
      const dataBase64 = await opts.source.read(offset, Math.min(chunk, size - offset));
      await link.request("attachment.chunk", { uploadId: begun.uploadId, index, dataBase64 });
      opts.onProgress?.({ sent: Math.min(offset + chunk, size), total: size });
    }
    return await link.request<CommittedAttachment>("attachment.commit", { uploadId: begun.uploadId });
  } catch (error) {
    void link.request("attachment.abort", { uploadId: begun.uploadId }).catch(() => undefined);
    throw error;
  }
}

/** One composer attachment, uploaded to the thread's host; the result names paths there. */
export async function uploadAttachment(
  threadEnv: string,
  sessionId: string,
  file: Attachment,
  onProgress?: (progress: UploadProgress) => void,
): Promise<Attachment> {
  const { maxBytes } = await attachmentSettings(threadEnv);
  const origin = file.environmentId;
  try {
    const source = file.blob
      ? await blobSource(file.blob)
      : file.path && origin
        ? await hostSource(origin, file.path)
        : null;
    if (!source) throw new Error(`${file.name} has nothing left to upload; attach it again`);
    if (source.size > maxBytes) throw new Error(overLimitMessage({ name: file.name, size: source.size }, maxBytes));
    const landed = await uploadFile({
      threadEnv,
      sessionId,
      name: file.name,
      mime: file.mimeType,
      source,
      onProgress,
    });
    // An appshot's window text rides beside the image: it crosses too.
    let textPath: string | undefined;
    if (file.textPath && origin && origin !== threadEnv) {
      const text = await uploadFile({
        threadEnv,
        sessionId,
        name: `${file.name}.txt`,
        mime: "text/plain",
        source: await hostSource(origin, file.textPath),
      });
      textPath = text.path;
    }
    const next: Attachment = {
      ...file,
      path: landed.path,
      size: landed.size,
      environmentId: threadEnv,
      ...(textPath ? { textPath } : {}),
    };
    delete next.blob;
    return next;
  } catch (error) {
    throw new AttachmentUploadError(file.id, `Could not attach ${file.name}: ${friendly(error)}`);
  }
}

/** Every file of `files` that needs it, uploaded one after another; the
 *  rest pass through. `onUploaded` hands back each landed file at once, so
 *  a later failure does not upload the earlier ones again on the retry. */
export async function uploadAttachments(opts: {
  threadEnv: string;
  sessionId: string;
  files: Attachment[];
  onProgress?: (fileId: string, progress: UploadProgress) => void;
  onUploaded?: (file: Attachment) => void;
}): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const file of opts.files) {
    if (!needsUpload(file, opts.threadEnv)) {
      out.push(file);
      continue;
    }
    const landed = await uploadAttachment(opts.threadEnv, opts.sessionId, file, (p) => opts.onProgress?.(file.id, p));
    opts.onUploaded?.(landed);
    out.push(landed);
  }
  return out;
}
