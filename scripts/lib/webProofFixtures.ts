/** Local scratch pages for the §25 gate. Native controls keep Chrome's real AX routes. */
import { formHtml, frontHtml } from './fieldTasks'

export const WEB_NONCE = 'web-proof'
export const WEB_TITLES = {
  front: `TC field front ${WEB_NONCE}`,
  report: 'TC web report 40',
  large: 'TC web report 300',
  form: `TC field form ${WEB_NONCE}`,
  refused: 'TC web refused value'
} as const

export function webReportHtml(rows: 40 | 300): string {
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `<tr><td>City ${String(i + 1).padStart(3, '0')}</td><td>${10_000 + (i + 1) * 137}</td></tr>`
  ).join('')
  return `<!doctype html><meta charset=utf-8><title>${rows === 40 ? WEB_TITLES.report : WEB_TITLES.large}</title>
<style>body{font:15px system-ui;margin:32px}td,th{padding:4px 16px;text-align:left}td{font-variant-numeric:tabular-nums}</style>
<h1>Quarterly report</h1><a href="report300.html">Read 300 rows</a>
<table aria-label="City revenue"><thead><tr><th>City</th><th>Revenue</th></tr></thead><tbody>${body}</tbody></table>
<p id=scroll-state role=status>Scroll position: 0</p>
<script>addEventListener('scroll',()=>document.getElementById('scroll-state').textContent='Scroll position: '+Math.round(scrollY))</script>`
}

export function webProofFixtures(): Record<string, string> {
  return {
    'front.html': frontHtml(WEB_NONCE),
    'report.html': webReportHtml(40),
    'report300.html': webReportHtml(300),
    'form.html': formHtml(WEB_NONCE) + '<p><a href="refused.html">Refused value page</a></p>',
    // Chrome ignores a select's AXValue; the pick route must also prove its value took.
    // This control rejects a pick synchronously, so a successful AX action cannot count as a change.
    'refused.html': `<!doctype html><meta charset=utf-8><title>${WEB_TITLES.refused}</title>
<style>body{font:15px system-ui;margin:32px}label{display:block;margin:12px 0}select{font:inherit;padding:4px}</style>
<h1>Refused value</h1><label>Locked plan <select id=locked><option>Starter</option><option>Team</option></select></label>
<p role=status>The plan stays Starter.</p><script>
const locked=document.getElementById('locked');
for(const event of ['input','change'])locked.addEventListener(event,()=>{locked.value='Starter'});
</script>`
  }
}
