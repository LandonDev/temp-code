import { memo, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { FileRefMenu } from './FileRefMenu'
import { useStreamVeil } from './veil'
import { useSmoothText } from './smooth'

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
  const sessions = useApp((s) => s.sessions)
  const select = useApp((s) => s.select)
  // Coarse chunks glide out through a reveal buffer, and each small step
  // dissolves in under the paint-only veil (mugen FadePainter).
  const shown = useSmoothText(text, streaming)
  // Thread mentions stay human here too (UserMessage does the same): the
  // token becomes a link on the title, clicking it opens the thread.
  const resolved = useMemo(
    () =>
      shown.replace(/@thread:([\w-]{6,})/g, (token, id: string) => {
        const title = sessions[id]?.title
        return title ? `[@${title.replace(/[[\]()]/g, '')}](#thread:${id})` : token
      }),
    [shown, sessions]
  )
  const veilRef = useRef<HTMLDivElement>(null)
  useStreamVeil(veilRef, shown, streaming)
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
      ref={veilRef}
      className={cn(
        // Zeron body: 14px / 22px line height on the bare panel. Relative:
        // the veil paints absolutely-positioned covers over new glyphs.
        'prose relative max-w-none text-[14px] leading-[22px] prose-p:my-2 prose-p:leading-[22px] prose-li:leading-[22px] prose-pre:bg-transparent prose-pre:p-0 prose-headings:font-medium'
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const isFile = !!href && !/^https?:\/\//.test(href) && !href.startsWith('#thread:')
            const anchor = (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (!href) return
                  // Real URLs leave the app; threads select; paths stay in it.
                  if (/^https?:\/\//.test(href)) window.open(href)
                  else if (href.startsWith('#thread:')) void select(href.slice('#thread:'.length))
                  else openFileRef(href)
                }}
                className="cursor-pointer"
              >
                {children}
              </a>
            )
            return isFile ? <FileRefMenu target={href}>{anchor}</FileRefMenu> : anchor
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
                <FileRefMenu target={target}>
                  <button
                    onClick={() => openFileRef(target)}
                    title="Open in Changes"
                    className="rounded bg-(--code-wash) px-1 py-0.5 font-mono text-[0.85em] text-(--code-text) transition-colors hover:underline"
                  >
                    {raw}
                  </button>
                </FileRefMenu>
              )
            }
            return (
              <code
                // Zeron inline code: violet-300 on a violet-400/12 wash.
                className="rounded bg-(--code-wash) px-1 py-0.5 font-mono text-[0.85em] text-(--code-text) break-words [overflow-wrap:anywhere] before:content-none after:content-none"
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
        {resolved}
      </Markdown>
    </div>
  )
})
