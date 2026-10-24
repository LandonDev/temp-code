#!/usr/bin/env python3
"""The iPhone scripts/ios-device.sh builds for, from `xcrun devicectl list devices --json-output`.

    pick-device.py <listing.json> [--model iPhone19,4] [--describe]

Physical iPhones only (the Duo simulator lists as an iPhone19,4 too, as
"simulated"); TC_DEVICE_MODEL narrows to one model identifier, because both
of the owner's phones are named "Landon's iPhone"; a `connected` device beats
one that is only paired, then the first row wins. Prints the CoreDevice
identifier (empty when none), or with --describe one line "name · model ·
iOS x · state" for the log.
"""
import json
import sys


def pick(rows, model=None):
    def hw(r):
        return r.get("hardwareProperties", {})

    def cp(r):
        return r.get("connectionProperties", {})

    phones = [r for r in rows if hw(r).get("deviceType") == "iPhone" and hw(r).get("reality", "physical") == "physical"]
    if model:
        phones = [r for r in phones if hw(r).get("productType") == model]
    connected = [r for r in phones if cp(r).get("tunnelState") == "connected"]
    ready = connected or [r for r in phones if "available" in cp(r).get("tunnelState", "") or cp(r).get("pairingState") == "paired"]
    rows = ready or phones
    return rows[0] if rows else None


def describe(row):
    hw = row.get("hardwareProperties", {})
    dp = row.get("deviceProperties", {})
    cp = row.get("connectionProperties", {})
    return f"{dp.get('name', '?')} · {hw.get('productType', '?')} · iOS {dp.get('osVersionNumber', '?')} · {cp.get('tunnelState', '?')}"


def main(argv):
    path = argv[1]
    model = None
    show = False
    args = argv[2:]
    while args:
        a = args.pop(0)
        if a == "--model":
            model = args.pop(0) or None
        elif a == "--describe":
            show = True
    try:
        rows = json.load(open(path))["result"]["devices"]
    except Exception:
        rows = []
    row = pick(rows, model)
    if row is None:
        print("")
        return
    print(describe(row) if show else row["identifier"])


if __name__ == "__main__":
    main(sys.argv)
