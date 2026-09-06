import { loadGhostText } from "../../lib/settings";
import { client } from "../../lib/tcserver/client";
import { dirPrefix } from "../../lib/tcserver/projects";
import { monaco } from "./monaco";
import { entryForUri } from "./models";
import { projectForModel } from "./lsp/idea";

/** AI ghost text: fill-in-the-middle over the sidecar's `fim.complete`,
 *  off by default (the Ghost text setting). Tab accepts, Esc dismisses. */
export function registerGhostText(): void {
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      async provideInlineCompletions(model, position, _context, token) {
        if (!loadGhostText()) return { items: [] };
        const entry = entryForUri(model.uri);
        const project = projectForModel(model);
        if (!entry || !project) return { items: [] };
        // ≥400 ms idle: wait it out; a keystroke cancels via the token.
        await new Promise((r) => setTimeout(r, 400));
        if (token.isCancellationRequested) return { items: [] };
        const offset = model.getOffsetAt(position);
        const text = model.getValue();
        const completion = await client
          .request<string | null>("fim.complete", {
            projectId: project.id,
            path: entry.path.slice(dirPrefix(project.cwd).length),
            prefix: text.slice(0, offset),
            suffix: text.slice(offset),
          })
          .catch(() => null);
        if (!completion || token.isCancellationRequested) return { items: [] };
        return {
          items: [
            {
              insertText: completion,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        };
      },
      disposeInlineCompletions: (): void => undefined,
    },
  );
}
