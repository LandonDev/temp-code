/**
 * The consent page's approve button, clicked once by the mint window
 * (staticMint.ts). claude.ai renders the button only after the page's own
 * requests answer (about a second after load, seen 2026-10-20), so a script
 * that looks once at load finds nothing and the hidden run waits out its
 * timeout. The button is then disabled until hcaptcha's passive check has
 * answered (a click on it does nothing), so a disabled button does not count
 * either. This one looks every 250 ms until an enabled button is there or
 * the time is up, then clicks it once. Only a button whose label says so is
 * clicked; nothing is guessed. Armed once per page: a second run on the
 * same page answers `armed` and does nothing more.
 */
export const CONSENT_LABELS = /^(authori[sz]e|allow|approve|accept|continue)$/i
export const CONSENT_WAIT_MS = 40_000

/** The script, for the labelled button; a test seam names the element to click instead. */
export function consentScript(selector?: string): string {
  const usable = `(b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'`
  const find = selector
    ? `[document.querySelector(${JSON.stringify(selector)})].find(${usable})`
    : `Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(${usable}).find((b) => ${CONSENT_LABELS.toString()}.test((b.innerText || b.textContent || b.value || '').trim()))`
  return `(() => {
  if (window.__tcConsent) return 'armed'
  const click = () => {
    const hit = ${find}
    if (!hit) return false
    clearInterval(window.__tcConsent)
    hit.click()
    return true
  }
  window.__tcConsent = setInterval(click, 250)
  setTimeout(() => clearInterval(window.__tcConsent), ${CONSENT_WAIT_MS})
  return click() ? 'clicked' : 'armed'
})()`
}

export const CONSENT_SCRIPT = consentScript()
