import { Skeleton } from "./ui/skeleton";
import { selectChunk } from "../surfaces/chunks";
import type { ChoiceSelect as Body } from "./choice-select-body";

export type { Choice } from "./choice-select-body";

/** The Base UI select rides its own chunk (dialogs and settings open it on a
 *  click, never in the first paint); until it lands the field is a still
 *  block of its size. */
export const ChoiceSelect = selectChunk.surface("ChoiceSelect", <Skeleton className="h-8 w-40" />) as typeof Body;
