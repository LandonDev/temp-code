import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

/** Assistant markdown on the app's tokens; fenced code goes to shiki. */
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-transparent prose-pre:p-0 prose-headings:font-medium">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '')
            const raw = String(children)
            // Fenced blocks come through with a language class or a newline.
            if (match || raw.includes('\n')) {
              return <CodeBlock code={raw} lang={match?.[1] ?? 'text'} streaming={streaming} />
            }
            return (
              <code
                className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] before:content-none after:content-none"
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
