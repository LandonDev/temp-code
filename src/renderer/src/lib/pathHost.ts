/**
 * Which host a path opens on. A path alone says nothing about where it
 * lives: `/tmp/shot.png` exists on the box when a box thread wrote it, and
 * the Mac has nothing there. The catalog knows the roots each host holds
 * (its projects and workspaces), and a thread knows its own host; this is
 * the one rule the file tabs, the media viewer, the transcript's path chips
 * and "Open on the Mac" all follow. Pure: no store, no registry.
 */

export type PathHostInput = {
  /** Hosts whose catalog roots (a project cwd or a workspace path) hold the path. */
  owners: readonly string[];
  /** The host of the thread that named the path, when a thread did. */
  threadHost?: string;
  /** Environment zero: this machine. */
  primary: string;
};

/**
 * A catalog root is a definite answer: a box project's file is on the box,
 * a Mac project's file the box thread fetched through the bridge is on the
 * Mac. Outside every root the thread's host is the only thing that knows
 * the path, so it wins over this machine; with no thread (the file tree,
 * search, a drop) the path is one the person opened here.
 */
export function hostForPath({ owners, threadHost, primary }: PathHostInput): string {
  if (threadHost && owners.includes(threadHost)) return threadHost;
  return owners[0] ?? threadHost ?? primary;
}

/**
 * The line under "Couldn't open <name>" when a read failed on `hostName`
 * (null for this machine). The server's message carries the path and
 * node's spelling; the header already names the file, so a missing one
 * says where it is missing from and nothing else.
 */
export function openFailureText(message: string, hostName: string | null): string {
  if (/\bENOENT\b/.test(message)) return hostName ? `No such file on ${hostName}.` : "No such file.";
  return message;
}
