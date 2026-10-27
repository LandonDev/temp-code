import { convertFileSrc, invokeOn, open } from "./native";
import {
  notifyTabGroupLogosChanged,
  saveTabGroupLogo,
  tabGroupLogoDisplayRevision,
} from "./tabGroups";

export async function pickImageFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Choose project logo",
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
      },
    ],
  });
  if (typeof selected === "string" && selected) return selected;
  return null;
}

export async function pickAndSetProjectLogo(environmentId: string, project: string): Promise<string | null> {
  const sourcePath = await pickImageFile();
  if (!sourcePath) return null;
  return setProjectLogo(environmentId, project, sourcePath);
}

/** Saves an image already picked (the Customize dialog holds it until Save). */
export async function setProjectLogo(environmentId: string, project: string, sourcePath: string): Promise<string> {
  const path = await invokeOn<string>(environmentId, "save_project_logo", {
    project,
    sourcePath,
  });
  saveTabGroupLogo(project, path);
  notifyTabGroupLogosChanged();
  return path;
}

export async function clearProjectLogo(environmentId: string, project: string): Promise<void> {
  await invokeOn(environmentId, "remove_project_logo", { project });
  saveTabGroupLogo(project, null);
  notifyTabGroupLogosChanged();
}

export function projectLogoSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${convertFileSrc(path)}?v=${tabGroupLogoDisplayRevision()}`;
}
