import { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { CodeBlock } from './CodeBlock'

/** `src/foo/bar.ts`, `./x.css:12`, `/abs/path.rs` — things worth linking.
 *  Requires a directory and an extension so prose in backticks stays prose. */
const FILE_REF =
  /^(?:\.{0,2}\/|~\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/
/** Bare `file.ext` — linked only when the project actually has that file. */
const BARE_FILE = /^[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

/** Assistant markdown on the app's tokens; fenced code goes to shiki,
 *  links open externally, file references open the Changes rail. */
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  const openFileRef = useApp((s) => s.openFileRef)
  const files = useApp((s) => (s.selectedProjectId ? s.files[s.selectedProjectId] : undefined))
  const byBasename = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of files ?? []) {
      const base = p.split('/').pop()
      if (base && !m.has(base)) m.set(base, p)
    }
    return m
  }, [files])
  /** Project path for a code span, if it reads as a file reference. */
  const refTarget = (raw: string): string | null => {
    if (FILE_REF.test(raw)) return raw
    if (BARE_FILE.test(raw)) return byBasename.get(raw.replace(/:\d+(?::\d+)?$/, '')) ?? null
    return null
  }
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-headings:font-medium',
        streaming && 'streaming-prose'
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (!href) return
                  // Real URLs leave the app; anything path-like stays in it.
                  if (/^https?:\/\//.test(href)) window.open(href)
                  else openFileRef(href)
                }}
                className="cursor-pointer"
              >
                {children}
              </a>
            )
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '')
            const raw = String(children)
            // Fenced blocks come through with a language class or a newline.
            if (match || raw.includes('\n')) {
              return <CodeBlock code={raw} lang={match?.[1] ?? 'text'} streaming={streaming} />
            }
            const target = refTarget(raw)
            if (target) {
              return (
                <button
                  onClick={() => openFileRef(target)}
                  title="Open in Changes"
                  className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] transition-colors hover:bg-accent hover:underline"
                >
                  {raw}
                </button>
              )
            }
            return (
              <code
                className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] break-words [overflow-wrap:anywhere] before:content-none after:content-none"
                {...props}
              >
                {children}
              </code>
            )
          },
          pre({ children }) {
            // CodeBlock brings its own container.
            return <>{children}</>
          }
        }}
      >
        {text}
      </Markdown>
    </div>
  )
})
