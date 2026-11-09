import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonInput, AddonRow, AddonStatus, StoreHome } from "@shared/contract-addons";
import type { Skill, SkillFile, SkillInput, SkillMeta } from "@shared/contract-skills";
import type { ServerPush } from "@shared/contract";
import type { Link } from "../../lib/connection";

/**
 * A host for the Add-ons and Skills pages' tests: it keeps rows the way the
 * stores do (a new id with a taken name refused, `expectUpdatedAt` checked),
 * answers the reads, records every request and sends pushes. A method in
 * `silent` never answers; one in `refuse` answers with that error.
 */
export function fakeStoreHost(seed: { addons?: AddonRow[]; status?: Record<string, AddonStatus>; grants?: AddonGrantView[]; skills?: Skill[]; home?: StoreHome } = {}) {
  const state = {
    addons: [...(seed.addons ?? [])],
    status: { ...(seed.status ?? {}) },
    grants: [...(seed.grants ?? [])],
    skills: [...(seed.skills ?? [])],
    home: seed.home ?? null,
    silent: new Set<string>(),
    refuse: new Map<string, string>(),
  };
  const calls: { method: string; params: unknown }[] = [];
  const pushes = new Set<(push: ServerPush) => void>();
  const opens = new Set<() => void>();
  let clock = 100;

  const meta = (skill: Skill): SkillMeta => {
    const { files: _files, ...rest } = skill;
    return rest;
  };

  const handle = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "addons.list":
        return { addons: state.addons, status: state.status, home: state.home };
      case "addons.grant.list":
        return { grants: state.grants };
      case "addons.set": {
        const input = params.addon as AddonInput;
        const existing = state.addons.find((r) => r.id === input.id);
        const clash = state.addons.find((r) => r.workspaceId === input.workspaceId && r.name === input.name);
        if (clash && clash.id !== input.id) throw new Error(`refused: an add-on named ${input.name} already exists there`);
        const row: AddonRow = {
          id: input.id ?? `ad_minted${state.addons.length}`,
          name: input.name,
          workspaceId: input.workspaceId,
          description: input.description ?? existing?.description ?? "",
          spec: input.spec,
          enabled: input.enabled ?? existing?.enabled ?? true,
          addedBy: existing?.addedBy ?? { kind: "person" },
          writtenBy: { kind: "person" },
          createdAt: existing?.createdAt ?? clock,
          updatedAt: ++clock,
        };
        state.addons = [...state.addons.filter((r) => r.id !== row.id), row];
        return { addon: row };
      }
      case "addons.remove":
        state.addons = state.addons.filter((r) => r.id !== params.id);
        return { removed: true };
      case "addons.grant.setFields":
      case "addons.grant.clear":
      case "addons.grant.cancel":
        return {};
      case "addons.grant.signIn":
        return { started: true, port: 7787 };
      case "skills.list":
        return { skills: state.skills.map(meta), home: state.home };
      case "skills.get": {
        const skill = state.skills.find((s) => s.id === params.id);
        if (!skill) throw new Error(`refused: no skill ${String(params.id)}`);
        return { skill };
      }
      case "skills.set": {
        const input = params.skill as SkillInput;
        const expect = params.expectUpdatedAt as number | undefined;
        const existing = input.id ? state.skills.find((s) => s.id === input.id) : state.skills.find((s) => s.workspaceId === input.workspaceId && s.name === input.name);
        if (expect !== undefined && (existing?.updatedAt ?? 0) !== expect) throw new Error(`refused: ${input.name} changed since it was read`);
        const files: SkillFile[] = input.files;
        const skill: Skill = {
          id: existing?.id ?? `sk_minted${state.skills.length}`,
          name: input.name,
          workspaceId: input.workspaceId,
          description: existing?.description ?? "",
          harnesses: input.harnesses ?? "all",
          enabled: input.enabled ?? true,
          version: (existing?.version ?? 0) + 1,
          digest: `d${clock}`,
          bytes: 0,
          fileCount: files.length,
          addedBy: existing?.addedBy ?? { kind: "person" },
          writtenBy: { kind: "person" },
          createdAt: existing?.createdAt ?? clock,
          updatedAt: ++clock,
          files,
        };
        state.skills = [...state.skills.filter((s) => s.id !== skill.id), skill];
        return { skill: meta(skill) };
      }
      case "skills.remove": {
        const skill = state.skills.find((s) => s.id === params.id);
        const expect = params.expectUpdatedAt as number | undefined;
        if (skill && expect !== undefined && skill.updatedAt !== expect) throw new Error(`refused: ${skill.name} changed since it was read`);
        state.skills = state.skills.filter((s) => s.id !== params.id);
        return { removed: true };
      }
    }
    throw new Error(`unknown method: ${method}`);
  };

  const link = {
    environmentId: "local",
    profile: "local",
    connected: true,
    onOpen: (fn: () => void) => {
      opens.add(fn);
      return () => opens.delete(fn);
    },
    onClose: () => () => {},
    onPush: (fn: (push: ServerPush) => void) => {
      pushes.add(fn);
      return () => pushes.delete(fn);
    },
    request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (state.silent.has(method)) return new Promise<T>(() => {});
      const refusal = state.refuse.get(method);
      if (refusal) return Promise.reject(new Error(refusal));
      try {
        return Promise.resolve(handle(method, (params ?? {}) as Record<string, unknown>) as T);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  } as unknown as Link;

  return {
    link,
    state,
    calls,
    /** The requests of one method, their params. */
    sent: (method: string) => calls.filter((c) => c.method === method).map((c) => c.params),
    push: (push: ServerPush) => {
      for (const fn of pushes) fn(push);
    },
  };
}

export type FakeStoreHost = ReturnType<typeof fakeStoreHost>;
