import type { ReactNode } from "react";
import { ChunkBoundary } from "../../../lib/lazyChunk";
import { tagRendererError } from "../../../lib/rendererErrors";

/**
 * One board row's error boundary (the ChunkBoundary pattern, lib/lazyChunk.tsx):
 * a row whose record throws while rendering paints as a still 48px row
 * with "Couldn't load" and Retry, and the rows beside it, the board, the
 * rail and the master's transcript stay up. Retry mounts the row afresh,
 * so it reads the store again. The error reaches stalls.log's
 * `[renderer] caught <name>: <message>` line tagged with the master
 * thread and the row's session id (lib/rendererErrors.ts).
 */
export function RowBoundary({ threadId, rowId, children }: { threadId: string; rowId: string; children: ReactNode }) {
  return (
    <ChunkBoundary
      name={`board-row.${rowId}`}
      fallback={<div className="h-12" aria-hidden />}
      onRetry={() => {}}
      onError={(error) => tagRendererError(error, { thread: threadId, row: rowId })}
    >
      {children}
    </ChunkBoundary>
  );
}
