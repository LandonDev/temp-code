import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class list with Tailwind conflicts resolved (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
