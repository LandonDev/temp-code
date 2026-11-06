"""The Duo proof's per-shot check (scripts/ios-sim-proof.sh `pose_check`).

    python3 scripts/lib/duo_pose_check.py <png> <layout-report.json> <pose> <label> [<pose-sessionId.json>]

The layout report's window, size classes and classified pose must be the row
for <pose>, and the PNG the window times the scale. On a thread shot the dock
(the slot above the composer, the composer the column's width) and, from the
thread screen's own pose record, the rules of docs/IOS-DESIGN.md "The thread
screen on the iPhone Duo": the sidebar's state as asked (SHOT_SIDEBAR
shown|hidden) and its width (in [260, 320]; half open up to the fold), the
thread's column starting at the sidebar's edge (half open, past the fold's
band) and ending where the window less its safe area does; the mode ThreadPose gives the
column (SHOT_KIND: chat is one segment, every other type two; two panes from
680 at regular width) and the columns (TwoPaneColumns: the chat at least 360,
a hero of 320 up to half and 672, the fold's band as the gap); the text
measure (768, 640 for a lone plan, or the column less 32); the composer's box
on the column's edges; SHOT_DRAFT, the draft's length; and the dock's band
(duo_band.py: the dock its parts' height, the fade behind it no taller, the
bar at most a system bar more). Exit 1 on a mismatch.
"""
import json, math, os, struct, sys
from duo_band import band_problems
png, report, pose, label = sys.argv[1:5]
posefile = sys.argv[5] if len(sys.argv) > 5 else ''
rows = {
    'folded': (466, 678, 'compact', 'regular'),
    'folded-landscape': (678, 466, 'compact', 'compact'),
    'unfolded': (951, 669, 'regular', 'regular'),
    'unfolded-portrait': (669, 951, 'regular', 'regular'),
    'half-open': (951, 669, 'regular', 'regular'),
}
w, h, hs, vs = rows[pose]
try:
    r = json.load(open(report))
except Exception as e:
    print(f'ios-sim-proof: {pose}/{label}: no layout report ({e})', file=sys.stderr); sys.exit(1)
with open(png, 'rb') as f:
    f.seek(16); pw, ph = struct.unpack('>II', f.read(8))
got = (r.get('window', {}).get('w'), r.get('window', {}).get('h'), r.get('hSize'), r.get('vSize'))
ok = got == (w, h, hs, vs) and r.get('classified') == pose and abs(pw - w * 3) <= 1 and abs(ph - h * 3) <= 1
line = f"{pose}/{label} {got[0]}×{got[1]} {got[2]}×{got[3]} png {pw}×{ph} classified {r.get('classified')} hinge {(r.get('hinge') or {}).get('state')}"
if not ok:
    print(f'ios-sim-proof: POSE MISMATCH {line}', file=sys.stderr)
    print(f'ios-sim-proof: expected {pose} {w}×{h} {hs}×{vs} png {w*3}×{h*3}', file=sys.stderr)
    print(json.dumps(r, indent=1, sort_keys=True), file=sys.stderr)
    sys.exit(1)
print(f'ios-sim-proof: {line} ok')
# The dock on a thread shot: a slot that takes room ends above the composer
# with its own solid band, and the composer's box is the text column's width
# (C1: the box's edges are the column's).
notes = r.get('notes') or {}
if (r.get('route') or {}).get('thread') and 'composer.frame' in notes and 'measure' in notes:
    cx, cy, cw, ch = map(int, notes['composer.frame'].split(','))
    measure = int(notes['measure'])
    problems = []
    if abs(cw - measure) > 1:
        problems.append(f'composer {cw} wide, column {measure}')
    slot = notes.get('slot.frame', 'none')
    if slot != 'none':
        sx, sy, sw, sh = map(int, slot.split(','))
        if sy + sh > cy:
            problems.append(f'slot ends at {sy + sh}, composer starts at {cy}')
        if notes.get('dock.backing') != 'solid':
            problems.append(f"slot over a {notes.get('dock.backing')} backing")
    # The band behind the dock is the dock's parts' height (duo_band.py).
    problems += band_problems(notes)
    dock = f"{pose}/{label} dock: composer {cw} column {measure} slot {slot} backing {notes.get('dock.backing')} columns {notes.get('columns')} sidebar {notes.get('sidebar.width')}"
    if problems:
        print(f'ios-sim-proof: DOCK MISMATCH {dock}: ' + '; '.join(problems), file=sys.stderr)
        sys.exit(1)
    print(f'ios-sim-proof: {dock} ok')
    # C2: the thread screen's pose as the rules decide it for the column it was given
    # (pose-<sessionId>.json beside the report): the sidebar's width and state, the mode
    # and the columns (ThreadPose, TwoPaneColumns), the text measure, the composer's edges.
    P = json.load(open(posefile)) if posefile and os.path.exists(posefile) else None
    if P is None:
        print(f'ios-sim-proof: POSE RULE {pose}/{label}: no pose-<sessionId>.json for the thread', file=sys.stderr)
        sys.exit(1)
    kind, asked, draft = os.environ.get('SHOT_KIND', ''), os.environ.get('SHOT_SIDEBAR', ''), os.environ.get('SHOT_DRAFT', '')
    width, mode, regular = P['width'], P['mode'], P['regularWidth']
    problems = []
    def near(a, b, tol): return abs(a - b) <= tol
    # The sidebar: its state as asked, its width the shell's 260 (iOS holds it at 320
    # unfolded; half open it follows the fold), and the thread's column what it leaves.
    sb = notes.get('sidebar', '')
    sbw, split = int(notes.get('sidebar.width', '0')), int(notes.get('split.width', '0'))
    folded = pose in ('folded', 'folded-landscape')
    want_sb = 'stack' if folded else ({'shown': 'visible' if pose in ('unfolded', 'half-open') else 'overlay', 'hidden': 'hidden'}.get(asked) if asked else None)
    if want_sb and sb != want_sb: problems.append(f'sidebar {sb!r}, asked {asked!r} → {want_sb!r}')
    # What the shell holds: the window less its safe area's sides (the tab rail is the right inset).
    # The split's own note is information only: it once lagged a fold back by 4 pt.
    safe = r.get('safeArea') or {}
    held = r['window']['w'] - safe.get('left', 0) - safe.get('right', 0)
    body = notes.get('body.frame')
    bx = int(body.split(',')[0]) if body else None
    if bx is None:
        problems.append('no body.frame note')
    elif sb == 'visible':
        # Beside the thread: 260 asked, 320 held on iOS 27.1; half open the sidebar fills the
        # first panel and the thread starts past the fold's band (48 pt at most).
        hi = 320 if pose != 'half-open' else max(320, r['window']['w'] / 2 + 2)
        if not 260 <= sbw <= hi: problems.append(f'sidebar {sbw} wide, not in [260, {hi:g}]')
        band = 48 if pose == 'half-open' else 1.5
        if not -1.5 <= bx - safe.get('left', 0) - sbw <= band: problems.append(f'the column starts at {bx}, the sidebar ends at {sbw}')
    elif not near(bx, safe.get('left', 0), 1.5):
        problems.append(f'the column starts at {bx} with the sidebar {sb}')
    if bx is not None and not near(bx + width, held + safe.get('left', 0), 1.5):
        problems.append(f'the column {bx}+{width:g} does not end at the {held} held')
    # The mode for the column actually given: one segment alone; two panes from 680 at regular width.
    if kind:
        segments = 1 if kind == 'chat' else 2
        want = 'single' if segments < 2 else ('twoPane' if regular and width >= 680 else 'pager')
        if mode != want: problems.append(f'mode {mode}, ThreadPose says {want} at {width:g} ({"regular" if regular else "compact"})')
    hero = gap = 0
    column = width
    if mode == 'twoPane':
        c = P.get('columns') or {}
        hero, gap, chat = c.get('hero', 0), c.get('gap', 0), c.get('chat', 0)
        column = chat
        if not near(hero + gap + chat, width, 0.6): problems.append(f'columns {hero:g}+{gap:g}+{chat:g} ≠ {width:g}')
        if chat < 359.5: problems.append(f'chat {chat:g} under 360')
        d = P.get('division')
        if d and d['height'] > d['width'] and d['x'] >= 280 and width - d['x'] - d['width'] >= 280:
            if not (near(hero, d['x'], 0.6) and near(gap, d['width'], 0.6)): problems.append(f'columns {hero:g}/{gap:g} do not sit on the band {d}')
        else:
            half = math.floor((width - gap) / 2)
            if gap > 1.01: problems.append(f'gap {gap:g} is no hairline')
            if not 319.5 <= hero <= min(half, 672) + 0.5: problems.append(f'hero {hero:g} not in [320, {min(half, 672)}]')
            if kind and kind != 'implementation' and not near(hero, min(half, math.floor(width - gap - 360)), 1):
                problems.append(f'hero {hero:g}, the split gives {min(half, math.floor(width - gap - 360))}')
    elif mode == 'pager' and not near(P.get('pagerContainer', width), width, 1):
        problems.append(f"pager container {P.get('pagerContainer')} ≠ {width:g}")
    # The text measure: 768 (640 for a lone plan), or the column less its two 16 pt edges.
    cap = 640 if mode == 'single' and (r.get('route') or {}).get('segment') == 'plan' else 768
    want_measure = min(column - 32, cap)
    if not near(measure, want_measure, 1): problems.append(f'measure {measure}, want {want_measure:g}')
    # The composer's box on the column's edges.
    if bx is not None:
        left = bx + (hero + gap if mode == 'twoPane' else 0) + max(16, (column - cap) / 2)
        if not near(cx, left, 1.5): problems.append(f'composer starts at {cx}, the column at {left:g}')
    if draft and notes.get('draftChars') != draft: problems.append(f"draft {notes.get('draftChars')} chars, typed {draft}")
    rule = f"{pose}/{label} rule: {kind or '?'} {mode} column {width:g} sidebar {sb} {sbw}/{split} columns {notes.get('columns')} measure {measure} composer x {cx}"
    if problems:
        print(f'ios-sim-proof: POSE RULE MISMATCH {rule}: ' + '; '.join(problems), file=sys.stderr)
        sys.exit(1)
    print(f'ios-sim-proof: {rule} ok')
