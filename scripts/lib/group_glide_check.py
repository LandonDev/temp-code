"""The glide proof's check (scripts/ios-sim-proof.sh `glide_set`).

    python3 scripts/lib/group_glide_check.py <group-glide.json> <layout-events.json> <label>

The app taps a tool group open and shut three times (TC_TEST_GROUP_GLIDE) and
samples, every 8 ms for 0.9 s after each tap, the list's model offset and
content height and what is drawn: the presentation offset and each visible
cell's presentation top and height (`shown`; the model values jump to the
end of a UIKit animation, the presentation is what the person sees). The
desktop's height glide, held on what is drawn:

  - the group's cell (the one whose height changes) changes height in steps,
    never more than half its change in one sample;
  - every row on screen moves one way only and in steps (no step past half
    its travel when it travels over 24 pt);
  - a reader up reading: the rows above the group and the group's top hold
    within a point, and the model offset never moves;
  - a reader at the bottom is followed: the rows under the group hold within
    a point while the rows above move;
  - the group never draws over the row under it (its cell clips, and its
    bottom never passes that row's top);
  - a row drawn before the tap stays drawn until it has left the list's
    bounds (a row the change takes off screen glides out as a still image);
  - the content height changes, and no `jumpUp` lands in the layout events
    once the taps start (TranscriptTrace: an offset that drops over 200 pt
    and stays two frames; the proof's own scroll up comes before its
    `glide-taps` mark).

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


def series(shown, item):
    """(top, height) of `item` in every sample that draws it."""
    out = []
    for s in shown:
        for c in s['cells']:
            if int(c[0]) == item:
                out.append((c[1], c[2]))
                break
    return out


def one_way(name, ys):
    """Failures for a series that should move one way, in steps."""
    steps = [b - a for a, b in zip(ys, ys[1:])]
    travel = ys[-1] - ys[0]
    if abs(travel) < 1:
        return [], travel
    back = [round(d, 1) for d in steps if (d < -0.5 if travel > 0 else d > 0.5)]
    out = []
    if back:
        out.append(f'{name} turned back {len(back)} times ({back[:3]})')
    if abs(travel) > 24 and max(abs(d) for d in steps) > abs(travel) / 2:
        out.append(f'{name} moved {max(abs(d) for d in steps):.1f} of {abs(travel):.1f} pt in one frame: a jump, not a glide')
    return out, travel


glides = []
for i, p in enumerate(phases):
    s = p.get('samples') or []
    shown = p.get('shown') or []
    name = f"{'open' if p.get('opening') else 'fold'} {i // 2 + 1}"
    if len(s) < 20 or len(shown) < 20:
        failures.append(f'{name}: {len(s)} samples, {len(shown)} drawn'); continue
    y0, h0 = p.get('before') or s[0][1:]
    if abs(s[-1][2] - h0) < 1:
        failures.append(f'{name}: the content height never changed ({h0})')
    first = {int(c[0]): c for c in shown[0]['cells']}
    last = {int(c[0]): c for c in shown[-1]['cells']}
    both = sorted(set(first) & set(last))
    if not both:
        failures.append(f'{name}: no row drawn before and after'); continue
    g = max(both, key=lambda k: abs(last[k][2] - first[k][2]))
    grow = last[g][2] - first[g][2]
    if abs(grow) < 1:
        failures.append(f'{name}: the group never changed height'); continue
    gs = series(shown, g)
    bad, _ = one_way(f'{name}: the group height', [h for _, h in gs])
    failures += bad
    tops = {}
    for k in both:
        ys = [y for y, _ in series(shown, k)]
        bad, travel = one_way(f'{name}: row {k}', ys)
        failures += bad
        tops[k] = (ys, travel)
    above = [k for k in both if k <= g]
    below = [k for k in both if k > g]
    if not p.get('atBottom'):
        drift = max(abs(y - y0) for _, y, _ in s)
        if drift > 1:
            failures.append(f'{name}: the reader was up and the offset moved {drift:.1f} pt')
        held = [k for k in above if max(abs(y - tops[k][0][0]) for y in tops[k][0]) > 1]
        if held:
            failures.append(f'{name}: the reader was up and rows above the group moved ({held})')
    else:
        moved = [k for k in below if max(abs(y - tops[k][0][0]) for y in tops[k][0]) > 1]
        if moved:
            failures.append(f'{name}: the reader was at the bottom and rows under the group moved ({moved})')
    # A row drawn before the tap is drawn until it has left the list's bounds.
    height = shown[0].get('height')
    if height:
        seen = {}
        for sample in shown:
            cells = {int(c[0]): c for c in sample['cells']}
            for k, c in first.items():
                if k in cells:
                    seen[k] = cells[k]
                elif k in seen and seen[k][1] + seen[k][2] > 24 and seen[k][1] < height - 24:
                    failures.append(f'{name}: row {k} vanished at {sample["t"]:.3f} s while on screen ({seen[k][1]:.0f} pt)')
                    seen.pop(k)
    # The group never draws over the row under it.
    over = 0.0
    for sample in shown:
        cells = {int(c[0]): c for c in sample['cells']}
        if g in cells and g + 1 in cells:
            over = max(over, cells[g][1] + cells[g][2] - cells[g + 1][1])
    if over > 1:
        failures.append(f'{name}: the group drew {over:.1f} pt over the row under it')
    glides.append({'tap': name, 'grow': round(grow, 1), 'steps': len({round(h, 1) for _, h in gs}),
                   'above': round(tops[above[0]][1], 1) if above else None,
                   'below': round(tops[below[0]][1], 1) if below else None})
# Only the taps' own: the reader-up run first scrolls 700 pt up itself (a drag's stand-in).
taps_from = next((e.get('t', 0) for e in events if e.get('key') == 'proof' and e.get('to') == 'glide-taps'), None)
jumps = [e for e in events if e.get('key') == 'jumpUp' and (taps_from is None or e.get('t', 0) >= taps_from)]
if jumps:
    failures.append(f"{len(jumps)} jumpUp events: {[e.get('to') for e in jumps[:3]]}")
summary = {'label': label, 'mode': r.get('mode'), 'taps': len(phases),
           'travel': [round(p['samples'][-1][1] - (p.get('before') or p['samples'][0][1:])[0], 1) for p in phases if p.get('samples')],
           'growth': [round(p['samples'][-1][2] - (p.get('before') or p['samples'][0][1:])[1], 1) for p in phases if p.get('samples')],
           'glides': glides}
print('ios-sim-proof: glide ' + json.dumps(summary))
if failures:
    for f in failures:
        print(f'ios-sim-proof: GLIDE FAIL ({label}) {f}', file=sys.stderr)
    sys.exit(1)
print(f'ios-sim-proof: glide {label} PASS')
