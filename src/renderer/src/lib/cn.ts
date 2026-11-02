import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge told our own theme tokens, so `shadow-none` after
 *  `shadow-overlay` replaces it instead of sitting beside it, and our own
 *  utilities, so `text-pulse` (components.css) is not read as a text colour
 *  that replaces the colour beside it. */
const twMerge = extendTailwindMerge<"text-pulse">({
  extend: { theme: { shadow: ["overlay"] }, classGroups: { "text-pulse": ["text-pulse"] } },
});

/** Class list with Tailwind conflicts resolved (last wins). The one `cn`
 *  every component imports; components.json points shadcn's `utils` here. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
