import type { WorkspaceMeta } from '@shared/domain'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { OrchestrationRulesEditor } from './OrchestrationRules'
import { ThreadDefaultsEditor } from './ThreadDefaults'

/** Per-workspace overrides — thread defaults and orchestration rules —
 *  reached from the workspace's sidebar menu. Each section inherits the
 *  global settings until touched. */
export function WorkspaceSettingsDialog({
  workspace,
  onClose
}: {
  workspace: WorkspaceMeta
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{workspace.name} · settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          <section>
            <h3 className="text-[13px] font-medium">Thread defaults</h3>
            <div className="mt-3">
              <ThreadDefaultsEditor workspaceId={workspace.id} />
            </div>
          </section>
          <section className="border-t border-border/60 pt-5">
            <h3 className="text-[13px] font-medium">Orchestration rules</h3>
            <div className="mt-3">
              <OrchestrationRulesEditor workspaceId={workspace.id} />
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
