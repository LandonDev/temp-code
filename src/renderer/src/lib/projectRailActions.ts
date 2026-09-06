/**
 * The sidebar's workspace menu reuses the rail's appearance menu and
 * remove dialog instead of owning copies. The rail listens while mounted.
 */

const EVENT = "monocode:project-rail-action";

export type ProjectRailAction =
  | { kind: "menu"; path: string; x: number; y: number }
  | { kind: "remove"; path: string };

export function requestProjectRailAction(action: ProjectRailAction): void {
  window.dispatchEvent(new CustomEvent<ProjectRailAction>(EVENT, { detail: action }));
}

export function subscribeProjectRailActions(
  listener: (action: ProjectRailAction) => void,
): () => void {
  const handler = (event: Event) =>
    listener((event as CustomEvent<ProjectRailAction>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
