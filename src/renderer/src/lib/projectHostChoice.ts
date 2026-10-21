/**
 * Which host a new thread starts on inside a project that is checked out on
 * more than one: the host the user last chose or created a thread on there
 * (remembered per project key in localStorage), else this machine, else the
 * first host that has the project. A thread's host never changes afterwards
 * except through the header chip's move.
 */

const KEY = "monocode.projectHosts";

type Remembered = Record<string, string>;

export function loadProjectHosts(): Remembered {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

export function rememberProjectHost(projectKey: string, environmentId: string): void {
  const next = loadProjectHosts();
  if (next[projectKey] === environmentId) return;
  next[projectKey] = environmentId;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
}

/** Pure: the host a new thread lands on among `hosts` (the project's, in rail order). */
export function defaultProjectHost(
  hosts: readonly string[],
  remembered: string | undefined,
  primary: string,
): string | undefined {
  if (remembered && hosts.includes(remembered)) return remembered;
  if (hosts.includes(primary)) return primary;
  return hosts[0];
}

/** The member of a project (one workspace per host) a new thread starts in. */
export function newThreadMember<M extends { environmentId: string }>(
  members: readonly M[],
  projectKey: string,
  primary: string,
  remembered: Remembered = loadProjectHosts(),
): M | undefined {
  const host = defaultProjectHost(
    members.map((m) => m.environmentId),
    remembered[projectKey],
    primary,
  );
  return members.find((m) => m.environmentId === host);
}
