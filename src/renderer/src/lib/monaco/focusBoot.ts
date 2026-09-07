import { listDir } from "../fs";
import { client } from "../tcserver/client";
import { projectForCwd } from "../tcserver/projects";
import { workspaceStore } from "../tcserver/workspaces";

/**
 * Focus-boot: the moment a project is in front of the user, ask the server
 * to bring the IntelliJ engine up so the first completion already races a
 * warm connection. Gated on JVM build files (the engine only imports with
 * a build tool, so it is useless and 3 GB anywhere else). No monaco import:
 * the editor chunk connects to the same server later through lsp.ensure,
 * which is idempotent on the pool.
 */

const BUILD_FILES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

const warmed = new Set<string>();

/** Resolve the server project for a cwd, waiting for the catalog if needed. */
function resolveProject(cwd: string): Promise<{ id: string; cwd: string } | null> {
  const now = projectForCwd(cwd);
  if (now) return Promise.resolve(now);
  if (workspaceStore.getSnapshot().loaded) return Promise.resolve(null);
  return new Promise((resolve) => {
    const stop = workspaceStore.subscribe(() => {
      const found = projectForCwd(cwd);
      if (!found && !workspaceStore.getSnapshot().loaded) return;
      stop();
      resolve(found ?? null);
    });
  });
}

export async function warmProjectForCwd(cwd: string): Promise<void> {
  const project = await resolveProject(cwd);
  if (!project || warmed.has(project.id)) return;
  warmed.add(project.id);
  let jvm = false;
  try {
    jvm = (await listDir(project.cwd)).some((e) => BUILD_FILES.has(e.name));
  } catch {
    jvm = false;
  }
  if (!jvm) return;
  await client.request("lsp.ensure", { projectId: project.id, lang: "idea" }).catch(() => undefined);
}
