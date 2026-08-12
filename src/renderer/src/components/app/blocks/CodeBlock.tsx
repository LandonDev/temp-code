import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { highlight } from '../../../lib/highlight'

/**
 * Fenced code: bordered container with a language/copy header, shiki
 * highlighting (worker), and wrapped lines — a transcript never scrolls
 * sideways. Highlighting runs while streaming too, debounced so the worker
 * isn't hammered on every delta.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  streaming
}: {
  code: string
  lang: string
  streaming?: boolean
}): React.JSX.Element {
  const clean = code.replace(/\n$/, '')
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    let alive = true
    const run = (): void => {
      void highlight(clean, lang).then((h) => {
        if (alive && h) setHtml(h)
      })
    }
    if (!streaming) {
      run()
      return () => {
        alive = false
      }
    }
    const t = setTimeout(run, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [clean, lang, streaming])

  const copy = (): void => {
    void navigator.clipboard.writeText(clean)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block my-2 overflow-hidden rounded-lg border bg-card">
      <div className="flex h-8 items-center justify-between border-b border-border/60 py-1 pr-1.5 pl-3">
        <span className="font-mono text-[11px] text-muted-foreground/70">
          {lang !== 'text' ? lang : 'plain text'}
        </span>
        <button
          onClick={copy}
          title="Copy code"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      {html ? (
        <div
          className={cn('text-xs leading-5 [&_pre]:p-3', streaming && 'opacity-95')}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-3 text-xs leading-5">
          <code>{clean}</code>
        </pre>
      )}
    </div>
  )
})
