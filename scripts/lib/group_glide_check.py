"""The glide proof's check (scripts/ios-sim-proof.sh `glide_set`).

    python3 scripts/lib/group_glide_check.py <group-glide.json> <layout-events.json> <label>

The app taps a tool group open and shut three times (TC_TEST_GROUP_GLIDE) and
samples the list's offset and content height every 8 ms for 0.9 s after each
tap. The desktop's height glide, held here: a reader up reading never moves
(the offset stays within a point: only the rows under the group move); a
reader at the bottom is followed on the layout spring, the offset moving one
way only (down the page on an open, up on a fold, clamped), in several steps
rather than one (no step past half the travel when it travels over 24 pt);
the content height changes; and no `jumpUp` lands in the layout events
(TranscriptTrace: an offset that drops over 200 pt and stays two frames).
Exit 1 on a failure.
"""
import json, sys

report_path, events_path, label = sys.argv[1:4]
r = json.load(open(report_path))
try:
    events = json.load(open(events_path))
except Exception:
    events = []
failures = []
phases = r.get('phases') or []
if len(phases) != 6:
    failures.append(f'{len(phases)} taps recorded, want 6')
for i, p in enumerate(phases):
    s = p.get('samples') or []
    name = f"{'open' if p.get('opening') else 'fold'} {i // 2 + 1}"
    if len(s) < 20:
        failures.append(f'{name}: {len(s)} samples'); continue
    y0, h0 = p.get('before') or s[0][1:]
    ys = [y0] + [y for _, y, _ in s]
    hs = [h for _, _, h in s]
    if abs(hs[-1] - h0) < 1:
        failures.append(f'{name}: the content height never changed ({h0})')
    if not p.get('atBottom'):
        drift = max(abs(y - ys[0]) for y in ys)
        if drift > 1:
            failures.append(f'{name}: the reader was up and the offset moved {drift:.1f} pt')
        continue
    steps = [b - a for a, b in zip(ys, ys[1:])]
    travel = ys[-1] - ys[0]
    if p.get('opening'):
        back = [d for d in steps if d < -0.5]
    else:
        back = [d for d in steps if d > 0.5]
    if back:
        failures.append(f'{name}: the offset turned back {len(back)} times ({back[:3]})')
    if abs(travel) > 24 and max(abs(d) for d in steps) > abs(travel) / 2:
        failures.append(f'{name}: one step of {max(abs(d) for d in steps):.1f} pt of {abs(travel):.1f}: a jump, not a glide')
jumps = [e for e in events if e.get('key') == 'jumpUp']
if jumps:
    failures.append(f"{len(jumps)} jumpUp events: {[e.get('to') for e in jumps[:3]]}")
summary = {'label': label, 'mode': r.get('mode'), 'taps': len(phases),
           'travel': [round(p['samples'][-1][1] - (p.get('before') or p['samples'][0][1:])[0], 1) for p in phases if p.get('samples')],
           'growth': [round(p['samples'][-1][2] - (p.get('before') or p['samples'][0][1:])[1], 1) for p in phases if p.get('samples')]}
print('ios-sim-proof: glide ' + json.dumps(summary))
if failures:
    for f in failures:
        print(f'ios-sim-proof: GLIDE FAIL ({label}) {f}', file=sys.stderr)
    sys.exit(1)
print(f'ios-sim-proof: glide {label} PASS')
