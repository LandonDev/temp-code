import { useEffect, useState } from "react";
import { loadTabGroupLabels, TAB_GROUP_LABELS_CHANGED } from "../lib/tabGroups";

/** The names Customize set on workspaces, kept current as they change. */
export function useTabGroupLabels(): Record<string, string> {
  const [labels, setLabels] = useState(loadTabGroupLabels);
  useEffect(() => {
    const refresh = () => setLabels(loadTabGroupLabels());
    window.addEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
  }, []);
  return labels;
}
