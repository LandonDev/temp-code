"""The Duo proof's fold-run check (scripts/ios-sim-proof.sh `duo_fold_run`).

    python3 scripts/lib/duo_fold_check.py <layout dir> <bottom|scrolled-up> <draft length>

Reads <layout dir>/{unfolded,folded}/cycle-<run>-<n>-<pose>.json (+ .transcript.json;
each stop's dock band and solid backing through duo_band.py)
and <layout dir>/cycle-<run>/{events.json,samples.txt,row-inits.json}; writes
cycle-<run>/report.json. Exit 1 on a failure.
"""
import json, pathlib, sys
from duo_band import band_problems
out, run, draft = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
d = out / f'cycle-{run}'
names = [('unfolded', 1), ('folded', 2), ('unfolded', 3), ('folded', 4)]
reports = [json.loads((out / p / f'cycle-{run}-{i}-{p}.json').read_text()) for p, i in names]
transcripts = []
for p, i in names:
    f = out / p / f'cycle-{run}-{i}-{p}.transcript.json'
    transcripts.append(json.loads(f.read_text()) if f.exists() else {})
A, B, C, D = reports
events = json.loads((d / 'events.json').read_text())
failures = []
# The stack and the thread survived every change.
routes = [r['route'] for r in reports]
if not all(r == routes[0] for r in routes): failures.append(f'route changed: {routes}')
if not (routes[0].get('thread') and routes[0].get('segment') == 'chat'): failures.append(f'not the chat: {routes[0]}')
# The draft: the typed length, unchanged in all four.
drafts = [r.get('notes', {}).get('draftChars') for r in reports]
if drafts != [draft] * 4: failures.append(f'draft {drafts}, typed {draft}')
# The merged log must reach back past the first stop (the app keeps the newest 500).
if events and events[0]['t'] > A['t']: failures.append(f"the event log starts at {events[0]['t']} ms, after the first stop at {A['t']} ms")
# Each step is exactly one hSize flip, one window change and one sidebar change.
steps = [(A['t'], B['t'], 'regular', 'compact', '466x678', 'hidden', 'stack'), (B['t'], C['t'], 'compact', 'regular', '951x669', 'stack', 'hidden'), (C['t'], D['t'], 'regular', 'compact', '466x678', 'hidden', 'stack')]
for start, end, frm, to, window, sfrm, sto in steps:
    inside = [e for e in events if start < e['t'] <= end]
    flips = [e for e in inside if e['key'] == 'hSize']
    if not (len(flips) == 1 and flips[0]['from'] == frm and flips[0]['to'] == to): failures.append(f'hSize {start}..{end}: {flips}')
    windows = [e for e in inside if e['key'] == 'window']
    if not (len(windows) == 1 and windows[0]['to'] == window): failures.append(f'window {start}..{end}: {windows}')
    sides = [e for e in inside if e['key'] == 'sidebar']
    if not (len(sides) == 1 and sides[0]['from'] == sfrm and sides[0]['to'] == sto): failures.append(f'sidebar {start}..{end}: {sides}')
# The dock's band at every stop: a turn streams, so the slot holds the timer on a
# solid backing, and the dock is its parts' height through every flip (duo_band.py).
for (p, i), r in zip(names, reports):
    notes = r.get('notes', {})
    if notes.get('dock.backing') != 'solid': failures.append(f"stop {i} ({p}): dock.backing {notes.get('dock.backing')}, want solid")
    failures += [f'stop {i} ({p}): {x}' for x in band_problems(notes)]
# The reveal never goes back (a re-made row would start it again from nothing).
units = []
for line in (d / 'samples.txt').read_text().splitlines():
    first = line.split(' ')[0]
    if first.isdigit(): units.append(int(first))
drops = [(a, b) for a, b in zip(units, units[1:]) if b < a]
if drops: failures.append(f'revealedUnits went back {len(drops)} times: {drops[:4]}')
if run == 'bottom' and not (units and units[-1] > units[0] > 0): failures.append(f'the reveal did not grow on screen: {units[:3]}…{units[-3:]}')
# The reader's place.
if run == 'bottom':
    for name, r, t in zip('BCD', reports[1:], transcripts[1:]):
        if r.get('transcriptAtBottom') != 1: failures.append(f'{name}: off the bottom ({r.get("transcriptAtBottom")})')
        if t.get('reflowAnchor') != 1: failures.append(f'{name}: reflow anchor {t.get("reflowAnchor")}, want the end')
else:
    top = transcripts[0].get('topRow', -1)
    if top == -1 or transcripts[0].get('atBottom') != 0: failures.append(f'A: the reader was not up ({transcripts[0]})')
    for name, r, t in zip('BCD', reports[1:], transcripts[1:]):
        if r.get('transcriptAtBottom') != 0: failures.append(f'{name}: back at the bottom')
        if t.get('topRow') != top or t.get('reflowAnchor') != 2: failures.append(f'{name}: top row {t.get("topRow")} anchor {t.get("reflowAnchor")}, want {top} and a row')
# No row on screen made its state twice.
inits = json.loads((d / 'row-inits.json').read_text())
v = inits.get('violations', [])
if not inits.get('rows'): failures.append('no row-inits report')
if v: failures.append(f'{len(v)} rows on screen made their state again: ' + ', '.join(f"{x['key']}×{x['inits']}" for x in v[:8]))
summary = {'run': run, 'drafts': drafts, 'units': [units[0], units[-1]] if units else [], 'samples': len(units), 'tops': [t.get('topRow') for t in transcripts], 'anchors': [t.get('reflowAnchor') for t in transcripts], 'rows': len(inits.get('rows', {})), 'violations': len(v)}
(d / 'report.json').write_text(json.dumps({**summary, 'failures': failures}, indent=1))
print('ios-sim-proof: fold cycle ' + json.dumps(summary))
if failures:
    for f in failures: print(f'ios-sim-proof: FOLD CYCLE FAIL ({run}) {f}', file=sys.stderr)
    sys.exit(1)
print(f'ios-sim-proof: fold cycle {run} PASS (route and draft kept, one flip per step, the dock its parts height, the reveal never went back, the reader kept, no row made twice)')
