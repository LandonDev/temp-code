import { memo, useEffect, useState } from 'react'
import { highlight } from '../../../lib/highlight'

/**
 * Fenced code with shiki (worker-highlighted). While the block is still
 * streaming we render a plain <pre> — only the final text is highlighted
 * (docs/PLAN.md M3).
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
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (streaming) return
    let alive = true
    void highlight(code.replace(/\n$/, ''), lang).then((h) => {
      if (alive) setHtml(h)
    })
    return () => {
      alive = false
    }
  }, [code, lang, streaming])

  if (html && !streaming) {
    return (
      <div
        className="code-block my-2 overflow-x-auto rounded-md border text-xs [&_pre]:p-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <pre className="my-2 overflow-x-auto rounded-md border bg-card p-3 text-xs">
      <code>{code.replace(/\n$/, '')}</code>
    </pre>
  )
})
