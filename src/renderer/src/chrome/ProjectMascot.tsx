import { MASCOT_GRID, projectMascot } from "../lib/projectMascots";

type Props = {
  project: string;
  /** Project color; omit to inherit the surrounding text color. */
  color?: string;
  /** Explicit pick from the project menu; falls back to the hashed one. */
  name?: string | null;
  className?: string;
};

/** Pixel mascot standing in for the project's color dot. */
export function ProjectMascot({
  project,
  color,
  name,
  className = "size-4 shrink-0",
}: Props) {
  const mascot = projectMascot(project, name);
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${MASCOT_GRID} ${MASCOT_GRID}`}
      shapeRendering="crispEdges"
      className={className}
      fill="currentColor"
      style={color ? { color } : undefined}
    >
      <path d={mascot.restPath} />
    </svg>
  );
}
