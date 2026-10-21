import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "./session";

/** Two hosts: the Mac ("mac", where picked files live) and the box ("box", where the thread runs). */
const { hosts } = vi.hoisted(() => {
  type Call = { method: string; params: Record<string, unknown> };
  const hosts = {
    calls: { mac: [] as Call[], box: [] as Call[] },
    macFiles: new Map<string, Uint8Array>(),
    boxUploads: new Map<string, { name: string; size: number; sha256: string; parts: Uint8Array[]; next: number }>(),
    boxLanded: new Map<string, Uint8Array>(),
    maxBytes: 200 * 1024 * 1024,
    failChunk: -1,
  };
  return { hosts };
});

const sha = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

async function answer(env: "mac" | "box", method: string, params: Record<string, unknown>): Promise<unknown> {
  hosts.calls[env].push({ method, params });
  if (env === "mac") {
    const bytes = hosts.macFiles.get(params.path as string);
    if (!bytes) throw new Error("ENOENT");
    if (method === "attachment.digest") return { size: bytes.length, sha256: await sha(bytes) };
    if (method === "attachment.readRange") {
      const offset = params.offset as number;
      return { dataBase64: toB64(bytes.subarray(offset, offset + (params.length as number))), size: bytes.length };
    }
    throw new Error(`mac: unexpected ${method}`);
  }
  switch (method) {
    case "attachment.settings":
      return { maxBytes: hosts.maxBytes, chunkBytes: 4 };
    case "attachment.begin": {
      const id = `u${hosts.boxUploads.size + 1}`;
      hosts.boxUploads.set(id, { name: params.name as string, size: params.size as number, sha256: params.sha256 as string, parts: [], next: 0 });
      return { uploadId: id, chunkBytes: 4 };
    }
    case "attachment.chunk": {
      const up = hosts.boxUploads.get(params.uploadId as string)!;
      if (params.index !== up.next) throw new Error("out of order");
      if (params.index === hosts.failChunk) throw new Error("not connected");
      up.parts.push(fromB64(params.dataBase64 as string));
      up.next += 1;
      return { received: up.parts.reduce((n, p) => n + p.length, 0) };
    }
    case "attachment.commit": {
      const up = hosts.boxUploads.get(params.uploadId as string)!;
      const bytes = new Uint8Array(up.parts.flatMap((p) => [...p]));
      if (bytes.length !== up.size) throw new Error("size mismatch");
      if ((await sha(bytes)) !== up.sha256) throw new Error("sha mismatch");
      const path = `/srv/work/repo/.temp-code/attachments/s1/${up.name}`;
      hosts.boxLanded.set(path, bytes);
      return { path, name: up.name, kind: "file", size: up.size };
    }
    case "attachment.abort":
      hosts.boxUploads.delete(params.uploadId as string);
      return null;
  }
  throw new Error(`box: unexpected ${method}`);
}

vi.mock("./connection", () => ({
  registry: {
    linkOf: (env: "mac" | "box") => ({ environmentId: env, request: (method: string, params: Record<string, unknown>) => answer(env, method, params) }),
    primary: () => ({ environmentId: "mac" }),
  },
}));

import {
  AttachmentUploadError,
  bytesToBase64,
  copiesBytes,
  forgetAttachmentSettings,
  needsUpload,
  uploadAttachments,
} from "./attachmentUpload";

const file = (over: Partial<Attachment>): Attachment => ({ id: "f1", name: "report.pdf", mimeType: "application/pdf", kind: "file", size: 0, ...over });

beforeEach(() => {
  hosts.calls.mac = [];
  hosts.calls.box = [];
  hosts.macFiles.clear();
  hosts.boxUploads.clear();
  hosts.boxLanded.clear();
  hosts.maxBytes = 200 * 1024 * 1024;
  hosts.failChunk = -1;
  forgetAttachmentSettings();
});

describe("needsUpload", () => {
  it("is a file from another host, or a paste held only in memory", () => {
    expect(needsUpload(file({ path: "/Users/me/a.pdf", environmentId: "mac" }), "box")).toBe(true);
    expect(needsUpload(file({ path: "/Users/me/a.pdf", environmentId: "mac" }), "mac")).toBe(false);
    // No origin known: the thread's own host, as before.
    expect(needsUpload(file({ path: "/srv/x.pdf" }), "box")).toBe(false);
    expect(needsUpload(file({ blob: new Blob(["x"]) }), "mac")).toBe(true);
    // A small pasted image travels inline (attachment.save), not as an upload.
    expect(needsUpload(file({ blob: new Blob(["x"]), data: "eA==" }), "box")).toBe(false);
    expect(copiesBytes(file({ blob: new Blob(["x"]), data: "eA==" }), "box")).toBe(true);
    expect(copiesBytes(file({ path: "/srv/x.pdf", environmentId: "box" }), "box")).toBe(false);
  });
});

describe("uploadAttachments", () => {
  it("streams a Mac file to the box in awaited chunks and answers the landed path", async () => {
    const bytes = new TextEncoder().encode("0123456789abcdef!");
    hosts.macFiles.set("/Users/me/report.pdf", bytes);
    const progress: number[] = [];
    const uploaded: string[] = [];
    const same = file({ id: "f2", path: "/srv/work/repo/notes.md", environmentId: "box" });
    const out = await uploadAttachments({
      threadEnv: "box",
      sessionId: "s1",
      files: [file({ path: "/Users/me/report.pdf", environmentId: "mac", size: bytes.length }), same],
      onProgress: (_id, p) => progress.push(p.sent),
      onUploaded: (f) => uploaded.push(f.path!),
    });
    expect(out[0]).toMatchObject({ id: "f1", path: "/srv/work/repo/.temp-code/attachments/s1/report.pdf", environmentId: "box", size: 17 });
    expect(out[1]).toBe(same);
    expect(uploaded).toEqual(["/srv/work/repo/.temp-code/attachments/s1/report.pdf"]);
    expect([...hosts.boxLanded.values()][0]).toEqual(bytes);
    // 17 bytes in chunks of 4: five chunks, indexes in order, progress to the end.
    const chunks = hosts.calls.box.filter((c) => c.method === "attachment.chunk").map((c) => c.params.index);
    expect(chunks).toEqual([0, 1, 2, 3, 4]);
    expect(progress.at(-1)).toBe(17);
    // The bytes were read from the Mac in ranges, never whole.
    expect(hosts.calls.mac.filter((c) => c.method === "attachment.readRange")).toHaveLength(5);
  });

  it("uploads a pasted blob from memory", async () => {
    const out = await uploadAttachments({
      threadEnv: "box",
      sessionId: "s1",
      files: [file({ name: "big.log", blob: new Blob(["hello blob"]), size: 10 })],
    });
    expect(out[0].path).toBe("/srv/work/repo/.temp-code/attachments/s1/big.log");
    expect(out[0].blob).toBeUndefined();
    expect(hosts.calls.mac).toEqual([]);
  });

  it("carries an appshot's window text across beside the image", async () => {
    hosts.macFiles.set("/Users/me/shot.jpg", new Uint8Array([1, 2, 3]));
    hosts.macFiles.set("/Users/me/shot.txt", new TextEncoder().encode("window"));
    const [out] = await uploadAttachments({
      threadEnv: "box",
      sessionId: "s1",
      files: [file({ name: "shot", kind: "image", path: "/Users/me/shot.jpg", textPath: "/Users/me/shot.txt", environmentId: "mac" })],
    });
    expect(out.path).toBe("/srv/work/repo/.temp-code/attachments/s1/shot");
    expect(out.textPath).toBe("/srv/work/repo/.temp-code/attachments/s1/shot.txt");
  });

  it("refuses a file over the host's limit before sending a byte", async () => {
    hosts.maxBytes = 8;
    hosts.macFiles.set("/Users/me/report.pdf", new Uint8Array(9));
    const err = await uploadAttachments({
      threadEnv: "box",
      sessionId: "s1",
      files: [file({ path: "/Users/me/report.pdf", environmentId: "mac" })],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentUploadError);
    expect((err as AttachmentUploadError).fileId).toBe("f1");
    expect((err as Error).message).toMatch(/report\.pdf is 9 B, over the 8 B limit/);
    expect(hosts.calls.box.some((c) => c.method === "attachment.begin")).toBe(false);
  });

  it("aborts a failed upload and names the file, keeping the earlier one landed", async () => {
    hosts.macFiles.set("/Users/me/a.txt", new TextEncoder().encode("abc"));
    hosts.macFiles.set("/Users/me/b.txt", new TextEncoder().encode("0123456789"));
    hosts.failChunk = 1;
    const landed: string[] = [];
    const err = await uploadAttachments({
      threadEnv: "box",
      sessionId: "s1",
      files: [
        file({ id: "a", name: "a.txt", path: "/Users/me/a.txt", environmentId: "mac" }),
        file({ id: "b", name: "b.txt", path: "/Users/me/b.txt", environmentId: "mac" }),
      ],
      onUploaded: (f) => landed.push(f.id),
    }).catch((e: unknown) => e);
    expect((err as AttachmentUploadError).fileId).toBe("b");
    expect((err as Error).message).toBe("Could not attach b.txt: not connected");
    expect(landed).toEqual(["a"]);
    expect(hosts.calls.box.at(-1)?.method).toBe("attachment.abort");
  });
});

describe("bytesToBase64", () => {
  it("matches btoa across the 32 KiB step", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(atob(bytesToBase64(bytes)).length).toBe(70_000);
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  });
});
