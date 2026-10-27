import { useEffect } from 'react'
import { loadMacBridgeRules } from '../lib/macBridgeRules'
import { MacBridgeRuleList } from './MacBridgeRemember'
import { MacBridgeRunningList } from './MacBridgeRunning'
import { Modal } from './Modal'

/** The thread menu's "Mac approvals…": what this Mac lets the thread do without asking. */
export function MacBridgeRulesDialog({
  sessionId,
  title,
  onClose
}: {
  sessionId: string
  title: string
  onClose: () => void
}) {
  useEffect(() => void loadMacBridgeRules(), [])
  return (
    <Modal onClose={onClose} title="Mac approvals" description={title} size="md">
      <div className="flex flex-col gap-4 px-4 py-4">
        <MacBridgeRuleList
          sessionId={sessionId}
          empty="Nothing remembered. sudo, osascript, security and credential paths always ask."
        />
        <MacBridgeRunningList sessionId={sessionId} />
      </div>
    </Modal>
  )
}
