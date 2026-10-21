# Device fixtures

Captured on the user's Mac on 2026-10-21 (macOS 27.2, Xcode 27.0 beta at
/Applications/Xcode-beta.app, `xcode-select -p` pointing at the Command Line
Tools) over the Mac bridge, byte for byte, with
`DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`:

- `simctl-devices-empty.json` — `xcrun simctl list -j devices`: three runtimes
  installed, no device under any of them (the empty state).
- `devicectl-devices.json` — `xcrun devicectl list devices --json-output …`:
  an iPhone 17 Pro Max paired but away (tunnel disconnected), an iPad Pro
  unavailable, and an Apple TV 4K connected over the local network.
- `ps-simulators.txt` — `ps -axo pid,pcpu,rss,etime,command` filtered to the
  CoreSimulator processes: a TempCode app still alive inside device
  DC72C36B-… (its launchd_sim gone) and CoreSimulatorService at 33.9 %.
- `load.txt` — `sysctl -n hw.ncpu`, `sysctl -n vm.loadavg`, `uptime`: 16 cores,
  a one-minute load of 44.97.
- `xcode-version.plist` — `/Applications/Xcode-beta.app/Contents/version.plist`.

Hand-written, in simctl's exact shape, because the capture had no device:

- `simctl-devices-booted.json` — a booted iPhone 17 Pro whose UDID matches the
  ps fixture, a shut-down iPad, one "Shutting Down", and one unavailable
  (runtime gone) that the parser leaves out.
