import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge told our own theme tokens, so `shadow-none` after
 *  `shadow-overlay` replaces it instead of sitting beside it. */
const twMerge = extendTailwindMerge({ extend: { theme: { shadow: ["overlay"] } } });

/** Class list with Tailwind conflicts resolved (last wins). The one `cn`
 *  every component imports; components.json points shadcn's `utils` here. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
