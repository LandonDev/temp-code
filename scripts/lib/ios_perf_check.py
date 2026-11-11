#!/usr/bin/env python3
"""Judges the iPhone performance proof (scripts/ios-sim-proof.sh `perf_set`).

    ios_perf_check.py [--gates FILE] [--cores N] DIR [DIR ...] [--baseline DIR ...]

Each DIR holds one pass of the set: `<run>.json` as the app wrote it
(ios/TempCode/Sources/Perf/PerfRun.swift `PerfReport`) and `<run>.load.txt`,
the Mac's load when the run began. Three passes are the rule: a CPU target
reads the best pass (load only adds), a count must hold in every pass.

A gate is a named target of docs/IOS-DESIGN.md "Performance". The gates
file (ios_perf_gates.json beside this script) says which are on; one that is
off is printed and never fails. A gate that has nothing to read (its run
missing, no frames recorded) fails when it is on. `late-frames` needs
--baseline: the same passes of the kept baseline app, taken in turn with
these. Exit 0 when every gate that is on holds, 5 otherwise.
"""
import json
import os
import sys

RUNS = ['scale-short', 'scale-build', 'follow', 'scroll-idle', 'scroll-busy', 'type-idle', 'type-busy', 'rest', 'master']
SCROLLS = ['scroll-idle', 'scroll-busy', 'master']
BODIES = ['projectShellBody', 'threadScreenBody', 'transcriptBody', 'bottomDockBody', 'composerBarBody', 'transcriptRowBody']


def load_pass(directory):
    reports = {}
    for run in RUNS:
        path = os.path.join(directory, run + '.json')
        if not os.path.exists(path):
            continue
        with open(path) as handle:
            report = json.load(handle)
        load_path = os.path.join(directory, run + '.load.txt')
        if os.path.exists(load_path):
            words = open(load_path).read().replace('{', ' ').replace('}', ' ').split()
            report['load'] = float(words[0]) if words else None
        reports[run] = report
    return reports


def measured(passes, run):
    """The run's reports that measured something."""
    return [p[run] for p in passes if run in p and not p[run].get('note')]


class Judge:
    def __init__(self, gates, passes, baseline, cores):
        self.gates = gates
        self.passes = passes
        self.baseline = baseline
        self.cores = cores
        self.failed = []
        self.lines = []

    def gate(self, name, problems, facts):
        on = self.gates.get(name, False)
        verdict = 'PASS' if not problems else ('FAIL' if on else 'miss')
        self.lines.append(f"{name:17} {'on ' if on else 'off'} {verdict}  {facts}")
        for problem in problems:
            self.lines.append(f"{'':17}     {problem}")
        if on and problems:
            self.failed.append(name)

    def best(self, run, path):
        """The lowest value of `path` (a.b) over the run's passes; None with nothing measured."""
        values = []
        for report in measured(self.passes, run):
            value = report
            for key in path.split('.'):
                value = value.get(key) if isinstance(value, dict) else None
            if value is not None:
                values.append(value)
        return min(values) if values else None

    def need(self, runs):
        missing = [r for r in runs if len(measured(self.passes, r)) < len(self.passes)]
        return [f"{r}: {len(measured(self.passes, r))} of {len(self.passes)} passes measured" for r in missing]

    def judge(self):
        self.scroll_cpu()
        self.batch_turn()
        self.scale()
        self.keystroke()
        self.rest()
        self.load_only()
        self.bodies_per_batch()
        self.refolds()
        self.rows_built()
        self.keystroke_bodies()
        self.jumps()
        self.jump_up()
        self.late_frames()

    def scroll_cpu(self):
        problems = self.need(SCROLLS)
        facts = []
        for run in SCROLLS:
            p95, p99, worst = (self.best(run, 'cpuMs.' + k) for k in ('p95', 'p99', 'worst'))
            if p95 is None or not self.best(run, 'cpuMs.count'):
                problems.append(f'{run}: no interval was recorded')
                continue
            facts.append(f'{run} {p95}/{p99}/{worst}')
            if p95 > 8 or p99 > 12 or worst > 16:
                problems.append(f'{run}: main-thread CPU per interval p95 {p95}, p99 {p99}, worst {worst} ms (8, 12, 16)')
        self.gate('scroll-cpu', problems, 'p95/p99/worst ms: ' + ', '.join(facts))

    def batch_turn(self):
        problems = self.need(['follow'])
        p95 = self.best('follow', 'batchCpuMs.p95')
        if not self.best('follow', 'batchCpuMs.count'):
            problems.append('follow: no batch was timed')
        elif p95 > 2:
            problems.append(f'follow: an applied batch costs p95 {p95} ms (2)')
        self.gate('batch-turn', problems, f'follow p95 {p95} ms')

    def scale(self):
        problems = self.need(['scale-short', 'scale-build'])
        short, build = self.best('scale-short', 'batchCpuMs.p95'), self.best('scale-build', 'batchCpuMs.p95')
        ratio = None
        if not short or build is None:
            problems.append('scale: no batch was timed in one of the two threads')
        else:
            ratio = round(build / short, 2)
            if ratio > 1.5:
                problems.append(f'12,000 rows cost {ratio} times 600 rows ({build} against {short} ms; 1.5)')
        self.gate('scale', problems, f'build {build} ms / short {short} ms = {ratio}')

    def keystroke(self):
        runs = ['type-idle', 'type-busy']
        problems = self.need(runs)
        facts = []
        for run in runs:
            p95, worst = self.best(run, 'keyCpuMs.p95'), self.best(run, 'keyCpuMs.worst')
            if not self.best(run, 'keyCpuMs.count'):
                problems.append(f'{run}: no key was timed')
                continue
            facts.append(f'{run} {p95}/{worst}')
            if p95 > 3 or worst > 8:
                problems.append(f'{run}: a keystroke costs p95 {p95}, worst {worst} ms (3, 8)')
            for report in measured(self.passes, run):
                if report.get('keys', 0) < 140:
                    problems.append(f"{run}: {report.get('keys', 0)} of 140 keys went in")
                if report.get('wraps', 0) < 2:
                    problems.append(f"{run}: the field wrapped {report.get('wraps', 0)} times, so wraps are not in the number")
        heights = [r.get('keyboardHeight', 0) for run in runs for r in measured(self.passes, run)]
        keyboard = '' if all(h >= 100 for h in heights) else '; no keyboard was up in some pass'
        self.gate('keystroke', problems, 'p95/worst ms: ' + ', '.join(facts) + keyboard)

    def rest(self):
        problems = self.need(['rest'])
        value = self.best('rest', 'cpuMsPerS')
        if not self.best('rest', 'cpuMs.count'):
            problems.append('rest: no interval was recorded')
        elif value > 10:
            problems.append(f'rest: {value} ms of main-thread CPU per second with nothing arriving (10)')
        self.gate('rest', problems, f'{value} ms per second')

    def load_only(self):
        problems = self.need(['follow'])
        seen = {}
        for report in measured(self.passes, 'follow'):
            counts = report.get('loadOnly')
            if counts is None:
                problems.append('follow: no load-only window was counted')
                continue
            for body in BODIES:
                seen[body] = max(seen.get(body, 0), counts.get(body, 0))
                if counts.get(body, 0):
                    problems.append(f"follow: {body} ran {counts[body]} times while only other threads and sessions got pushes")
        self.gate('load-only', sorted(set(problems)), ', '.join(f'{k} {v}' for k, v in seen.items()))

    def bodies_per_batch(self):
        problems = self.need(['follow'])
        facts = []
        for report in measured(self.passes, 'follow'):
            stream = report.get('stream') or {}
            bodies, batches, seconds = stream.get('transcriptBody', 0), stream.get('batches', 0), report.get('streamSeconds', 0)
            facts.append(f'{bodies} bodies, {batches} batches, {seconds} s')
            if not batches:
                problems.append('follow: no batch landed while the thread streamed')
            elif bodies > batches or bodies > 62 * seconds:
                problems.append(f'follow: the transcript ran {bodies} times for {batches} batches in {seconds} s')
        self.gate('bodies-per-batch', problems, '; '.join(facts))

    def refolds(self):
        problems = self.need(['type-busy'])
        counts = [r.get('counters', {}).get('refolds', 0) for r in measured(self.passes, 'type-busy')]
        for count in counts:
            if count > 3:
                problems.append(f'type-busy: {count} whole refolds while 1,000 rows streamed past the cap (3)')
        self.gate('refolds', problems, f'{counts}')

    def rows_built(self):
        runs = ['follow', 'scale-short', 'scale-build']
        problems = self.need(runs)
        facts = []
        for run in runs:
            for report in measured(self.passes, run):
                built, live = report.get('batchRows', {}).get('p95', 0), report.get('liveTurnRows', 0)
                facts.append(f'{run} {built}/{live}')
                if built > live:
                    problems.append(f'{run}: {built} rows built per batch at p95, the live turn holds {live}')
        self.gate('rows-built', problems, 'built/live: ' + ', '.join(facts))

    def keystroke_bodies(self):
        problems = self.need(['type-idle'])
        facts = []
        for report in measured(self.passes, 'type-idle'):
            counts = report.get('typing') or {}
            facts.append(', '.join(f'{k} {counts.get(k, 0)}' for k in BODIES + ['composerRowBody']))
            for body in ['projectShellBody', 'threadScreenBody', 'transcriptBody', 'bottomDockBody', 'transcriptRowBody', 'composerRowBody']:
                if counts.get(body, 0):
                    problems.append(f"type-idle: {body} ran {counts[body]} times for {report.get('keys', 0)} keys")
            if counts.get('composerBarBody', 0) > 1:
                problems.append(f"type-idle: the composer bar ran {counts['composerBarBody']} times for {report.get('keys', 0)} keys (once, when it gains content)")
        self.gate('keystroke-bodies', sorted(set(problems)), '; '.join(facts))

    def jumps(self):
        runs = ['scroll-idle', 'scroll-busy']
        problems = self.need(runs)
        facts = []
        for run in runs:
            for report in measured(self.passes, run):
                cold, warm = report.get('jumpCount', [0, 0])
                travel = report.get('travelPt', [0, 0])
                worst = report.get('worstJumpPt', 0)
                facts.append(f'{run} cold {cold} in {round(travel[0])} pt, warm {warm}, worst {worst} pt')
                if travel[0] < 1_000 or travel[1] < 1_000:
                    problems.append(f'{run}: the list moved {round(travel[0])} and {round(travel[1])} pt, so nothing was scrolled')
                if warm:
                    problems.append(f'{run}: {warm} rows jumped on the warm pass')
                if cold > travel[0] / 10_000:
                    problems.append(f'{run}: {cold} rows jumped in {round(travel[0])} pt of the cold pass (1 per 10,000)')
                if worst > 8:
                    problems.append(f'{run}: a row jumped {worst} pt (8)')
        self.gate('jumps', problems, '; '.join(facts))

    def jump_up(self):
        problems = []
        ups = writes = 0
        for run in RUNS:
            for report in measured(self.passes, run):
                ups += report.get('jumpUps', 0)
                moving = report.get('counters', {}).get('offsetWritesMoving', 0)
                writes += moving
                if report.get('jumpUps', 0):
                    problems.append(f"{run}: {report['jumpUps']} jumpUp")
                if moving:
                    problems.append(f'{run}: the app wrote the offset {moving} times while the reader moved')
        self.gate('jump-up', problems, f'{ups} jumpUp, {writes} writes under a moving reader')

    def late_frames(self):
        problems = []
        facts = []
        if not self.baseline:
            problems.append('no baseline passes were given (--baseline)')
        for run in RUNS:
            ours = measured(self.passes, run)
            theirs = measured(self.baseline, run)
            if not ours:
                continue
            late = sum(r.get('late', 0) for r in ours)
            if theirs:
                was = sum(r.get('late', 0) for r in theirs)
                facts.append(f'{run} {late}/{was}')
                if late > was / 2:
                    problems.append(f'{run}: {late} late frames against the baseline\'s {was} (at most half)')
            for report in ours:
                quiet = self.cores and report.get('load') is not None and report['load'] < self.cores
                if quiet and report.get('hitchMsPerS', 0) > 5:
                    problems.append(f"{run}: {report['hitchMsPerS']} ms of hitch per second at a load of {report['load']} (5)")
        self.gate('late-frames', problems, 'late ours/baseline: ' + ', '.join(facts))


def table(passes):
    """One line a run: what each pass measured, for the findings file."""
    lines = ['run            pass load   frames late hitch/s  cpu p95/p99/worst  batch p95  key p95/worst  rows  note']
    for run in RUNS:
        for index, reports in enumerate(passes):
            r = reports.get(run)
            if r is None:
                lines.append(f'{run:14} {index + 1:>4} missing')
                continue
            cpu, frames = r.get('cpuMs', {}), r.get('frames', {})
            load = r.get('load')
            lines.append(
                f"{run:14} {index + 1:>4} {load if load is not None else '?':>5} {frames.get('count', 0):>7} {r.get('late', 0):>4} {r.get('hitchMsPerS', 0):>7}  "
                f"{cpu.get('p95', 0):>5}/{cpu.get('p99', 0)}/{cpu.get('worst', 0):<8} {r.get('batchCpuMs', {}).get('p95', 0):>9}  "
                f"{r.get('keyCpuMs', {}).get('p95', 0):>5}/{r.get('keyCpuMs', {}).get('worst', 0):<6} {r.get('rowsHeld', 0):>5}  {r.get('note') or ''}"
            )
    return lines


def main(argv):
    gates_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ios_perf_gates.json')
    baseline, directories, cores = [], [], 0
    index = 0
    target = directories
    while index < len(argv):
        word = argv[index]
        if word == '--gates':
            index += 1
            gates_path = argv[index]
        elif word == '--cores':
            index += 1
            cores = int(argv[index])
        elif word == '--baseline':
            target = baseline
        elif word == '--':
            target = directories
        else:
            target.append(word)
        index += 1
    if not directories and baseline:
        # `--baseline` takes every directory after it until `--`; with none after, the last ones are ours.
        print('ios-perf-check: name the passes to judge after `--`', file=sys.stderr)
        return 2
    if not directories:
        print(__doc__, file=sys.stderr)
        return 2
    with open(gates_path) as handle:
        gates = json.load(handle)
    passes = [load_pass(d) for d in directories]
    judge = Judge(gates, passes, [load_pass(d) for d in baseline], cores)
    judge.judge()
    for line in table(passes):
        print('ios-perf: ' + line)
    for line in judge.lines:
        print('ios-perf-gate: ' + line)
    if judge.failed:
        print('ios-perf-check: FAIL ' + ', '.join(judge.failed), file=sys.stderr)
        return 5
    print('ios-perf-check: PASS (' + str(sum(1 for on in gates.values() if on)) + ' gates on)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
