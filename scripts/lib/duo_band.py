"""The dock's band, held by duo_pose_check.py on every thread shot and by
duo_fold_check.py at every stop of the fold cycle.

The dock (the slot above the composer, the composer, 6 pt above and below) is
its parts' height and nothing more, and the band behind it (BottomEdgeFade,
`dock.fade.frame`) is the dock's height: on 2026-11-06 an empty slot reserved
at regular width took the whole column the bottom bar offered after an unfold
(slot 347 pt, dock 437 pt) and the blur covered the transcript. The bar (the
dock and the inset a floating system bar adds, `dock.bar.frame`) is the dock
plus at most that bar's 48 pt.
"""

PAD = 6        # BottomDock's padding above and below
SLOT_GAP = 8   # at most between the slot and the composer (ComposerMetrics.slotGap is 4)
BAR = 48       # Duo.barExtent


def rect(value):
    if not value or value == 'none':
        return None
    return tuple(int(v) for v in value.split(','))


def band_problems(notes):
    dock, fade, composer = rect(notes.get('dock.frame')), rect(notes.get('dock.fade.frame')), rect(notes.get('composer.frame'))
    slot, bar = rect(notes.get('slot.frame')), rect(notes.get('dock.bar.frame'))
    if not (dock and fade and composer):
        return ['no dock.frame, dock.fade.frame or composer.frame in the report']
    problems = []
    top = composer[1]
    if slot:
        gap = composer[1] - (slot[1] + slot[3])
        if gap > SLOT_GAP:
            problems.append(f'slot ends {gap} pt above the composer')
        if slot[3] > composer[3]:
            problems.append(f'slot {slot[3]} pt tall, taller than the composer\'s {composer[3]}')
        top = slot[1]
    parts = composer[1] + composer[3] - top + 2 * PAD
    if dock[3] > parts + 2:
        problems.append(f'dock {dock[3]} pt tall, its parts {parts}')
    if fade[3] > dock[3] + 1:
        problems.append(f'band {fade[3]} pt tall, dock {dock[3]}')
    if bar and bar[3] > dock[3] + BAR + 1:
        problems.append(f'bar {bar[3]} pt tall, dock {dock[3]} and a {BAR} pt system bar at most')
    return problems
