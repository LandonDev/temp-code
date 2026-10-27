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
    <Modal onClose={onClose} title={`Mac approvals · ${title}`} size="md">
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[12px] leading-snug text-content/50">
          {'What this Mac lets the thread do without asking. They end when the app quits or the thread is removed. ' +
            'sudo, osascript, security, launchctl, defaults write, a wide rm -r and credential paths always ask.'}
        </p>
        <MacBridgeRuleList sessionId={sessionId} empty="Nothing remembered: every command asks." />
        <MacBridgeRunningList sessionId={sessionId} />
      </div>
    </Modal>
  )
}
