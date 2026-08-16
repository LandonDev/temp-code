import type { ThemeRegistration } from 'shiki'

/**
 * IntelliJ IDEA's editor palettes as TextMate themes: IntelliJ Light and
 * Darcula. Hand-authored from the IDEA defaults — orange/blue keywords,
 * green strings, purple fields, yellow/teal methods, olive annotations —
 * with types, punctuation, and parameters deliberately left at the
 * default foreground, exactly as IDEA paints them. The editor overlays
 * its own workbench colors (app backgrounds win); the transcript worker
 * uses these as-is on a transparent block.
 *
 * The semantic-token layer (semantic-rules.ts) repaints anything the
 * language servers classify; these rules are the base coat and the whole
 * story for non-LSP languages. A bare `keyword` scope must stay present:
 * the monaco theme trie routes jdtls `keyword` semantic tokens through it.
 */

interface Tone {
  fg: string
  bg: string
  comment: string
  docComment: string
  docTag: string
  keyword: string
  string: string
  number: string
  annotation: string
  field: string
  func: string
  tag: string
  attribute: string
}

const DARCULA: Tone = {
  fg: '#A9B7C6',
  bg: '#2B2B2B',
  comment: '#808080',
  docComment: '#629755',
  docTag: '#629755',
  keyword: '#CC7832',
  string: '#6A8759',
  number: '#6897BB',
  annotation: '#BBB529',
  field: '#9876AA',
  func: '#FFC66D',
  tag: '#E8BF6A',
  attribute: '#BABABA'
}

const LIGHT: Tone = {
  fg: '#080808',
  bg: '#FFFFFF',
  comment: '#8C8C8C',
  docComment: '#8C8C8C',
  docTag: '#8C8C8C',
  keyword: '#0033B3',
  string: '#067D17',
  number: '#1750EB',
  annotation: '#9E880D',
  field: '#871094',
  func: '#00627A',
  tag: '#0033B3',
  attribute: '#174AD4'
}

function theme(name: string, type: 'light' | 'dark', t: Tone): ThemeRegistration {
  const rule = (
    scope: string | string[],
    foreground: string,
    fontStyle?: string
  ): { scope: string | string[]; settings: { foreground: string; fontStyle?: string } } => ({
    scope,
    settings: { foreground, ...(fontStyle ? { fontStyle } : {}) }
  })
  return {
    name,
    type,
    colors: { 'editor.background': t.bg, 'editor.foreground': t.fg },
    tokenColors: [
      { settings: { foreground: t.fg, background: t.bg } },
      rule(['comment', 'punctuation.definition.comment'], t.comment),
      rule(['comment.block.documentation', 'comment.block.javadoc'], t.docComment, 'italic'),
      rule(
        ['keyword.other.documentation', 'storage.type.class.jsdoc', 'variable.other.jsdoc'],
        t.docTag,
        'italic'
      ),
      rule(
        [
          'keyword',
          'storage',
          'constant.language',
          'variable.language',
          'constant.character.escape'
        ],
        t.keyword
      ),
      // IDEA leaves type names plain — undo the broad `storage` rule where
      // the java grammar uses it for types ("String s", generics).
      rule(
        ['storage.type.java', 'storage.type.generic.java', 'storage.type.object.array.java'],
        t.fg
      ),
      rule(['string', 'punctuation.definition.string', 'constant.character'], t.string),
      rule('constant.character.escape', t.keyword),
      rule('constant.numeric', t.number),
      rule(
        [
          'storage.type.annotation',
          'punctuation.definition.annotation',
          'meta.declaration.annotation',
          'entity.name.function.decorator',
          'punctuation.decorator',
          'meta.decorator'
        ],
        t.annotation
      ),
      rule(
        [
          'variable.other.property',
          'variable.other.object.property',
          'variable.other.member',
          'variable.other.constant',
          'support.type.property-name'
        ],
        t.field
      ),
      rule(['entity.name.function', 'support.function'], t.func),
      rule('entity.name.tag', t.tag),
      rule('entity.other.attribute-name', t.attribute),
      rule('markup.heading', t.keyword),
      rule('markup.inserted', t.string),
      rule('markup.deleted', type === 'dark' ? '#CF5B56' : '#C22D2D'),
      { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
      { scope: 'markup.bold', settings: { fontStyle: 'bold' } }
    ]
  }
}

export const darcula = theme('darcula', 'dark', DARCULA)
export const intellijLight = theme('intellij-light', 'light', LIGHT)

/**
 * Semantic-token theme rules (monaco trie, token = `type.modifier…`).
 * Modifier order in the trie key follows each server's legend bit order —
 * jdtls puts `static` before `declaration`, vtsls the reverse — so both
 * orders appear. The trie's root default repaints every in-legend token
 * to `fg`, which is IDEA's look for types/parameters; anything that must
 * KEEP a color (fields, declarations, jdtls modifier/keyword tokens)
 * needs a rule here.
 */
export function semanticRules(
  dark: boolean,
  fg: string
): { token: string; foreground?: string; fontStyle?: string }[] {
  const t = dark ? DARCULA : LIGHT
  return [
    { token: 'property', foreground: t.field },
    { token: 'property.static', fontStyle: 'italic' },
    { token: 'property.declaration.static', fontStyle: 'italic' },
    { token: 'enumMember', foreground: t.field, fontStyle: 'italic' },
    { token: 'recordComponent', foreground: t.field },
    // Call-sites go back to default; declarations wear IDEA's method color.
    { token: 'method', foreground: fg },
    { token: 'method.static', foreground: fg, fontStyle: 'italic' },
    { token: 'method.declaration', foreground: t.func },
    { token: 'method.static.declaration', foreground: t.func, fontStyle: 'italic' },
    { token: 'method.declaration.static', foreground: t.func, fontStyle: 'italic' },
    { token: 'method.abstract.declaration', foreground: t.func },
    { token: 'function', foreground: fg },
    { token: 'function.declaration', foreground: t.func },
    { token: 'decorator', foreground: t.annotation },
    { token: 'annotationMember', foreground: t.annotation },
    { token: 'modifier', foreground: t.keyword },
    { token: 'variable.readonly', foreground: t.field, fontStyle: 'italic' },
    { token: 'variable.declaration.readonly', foreground: t.field, fontStyle: 'italic' }
  ]
}
