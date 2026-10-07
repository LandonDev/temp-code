/**
 * Citations by evidence (research threads). An explorer that read a page
 * and found something records the claim the page supports; the app pins it
 * to the source row on the research board, so a row reads as what it
 * showed, not just where the agent went. Shared by the in-process claude
 * tool, the codex stdio bridge and the WS handler.
 */

export const CITE_TOOL_NAME = 'cite_source'

export const CITE_TOOL_DESCRIPTION =
  'Record a citation on the research board: the page or file you read and the one-line claim it supports. Call it after reading a source that supports a finding — that is how the board shows evidence beside each source. Only available inside a research thread and its subagents.'

export const CITE_TOOL_PARAMS = {
  url: 'The source: a public http(s) URL, or the path of a file in this repository.',
  claim: 'One line: the finding this source supports, specific enough to stand alone (a figure, a name, a date, a quote).',
  title: "The page's title, when you know it."
} as const

export const CITE_CLAIM_MAX = 300

export interface CiteSourceArgs {
  url: string
  claim: string
  title?: string
}
