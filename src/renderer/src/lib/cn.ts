import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class list with Tailwind conflicts resolved (last wins). The one `cn`
 *  every component imports; components.json points shadcn's `utils` here. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
