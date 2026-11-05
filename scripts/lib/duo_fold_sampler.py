"""The Duo fold run's sampler (scripts/ios-sim-proof.sh `duo_fold_run`).

    python3 scripts/lib/duo_fold_sampler.py <app Documents dir> <out dir>

Every 400 ms until SIGTERM: one line of `revealedUnits draftChars` from the
layout report into <out>/samples.txt, and the app's layout-events.json (the
newest 500 changes) merged into <out>/events.json, so a run that writes more
than 500 events keeps all of them without the app holding more.
"""
import json
import pathlib
import signal
import sys
import time

docs, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
seen: dict = {}
running = True


def stop(*_):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def merge():
    try:
        events = json.loads((docs / 'layout-events.json').read_text())
    except Exception:
        return
    for e in events:
        seen[(e.get('t'), e.get('key'), str(e.get('from')), str(e.get('to')))] = e


with open(out / 'samples.txt', 'w') as samples:
    while running:
        try:
            notes = json.loads((docs / 'layout-report.json').read_text()).get('notes', {})
            samples.write(f"{notes.get('revealedUnits', '')} {notes.get('draftChars', '')}\n")
            samples.flush()
        except Exception:
            pass
        merge()
        time.sleep(0.4)
merge()
(out / 'events.json').write_text(json.dumps(sorted(seen.values(), key=lambda e: e.get('t', 0))))
