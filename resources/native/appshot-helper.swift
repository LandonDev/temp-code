// appshot-helper — native side of Appshots.
//
// Subcommands (JSON on stdout, one object per line):
//   monitor                                  emit {"event":"hotkey"} on a bare double-⌘ tap
//   capture --exclude-pids 1,2 --out p.png   shoot the frontmost window + collect its AX text
//   permissions [--prompt]                   report {"screen":bool,"ax":bool}, optionally prompting
//
// Built by the electron.vite plugin with `swiftc -O` into resources/native/.
// Runs as a child of the app, so TCC prompts and grants attribute to the app.

import AppKit
import ApplicationServices
import ScreenCaptureKit

// MARK: - Output

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func fail(_ code: String, _ detail: String = "") -> Never {
  emit(detail.isEmpty ? ["error": code] : ["error": code, "detail": detail])
  exit(1)
}

// MARK: - permissions

func axTrusted(prompt: Bool) -> Bool {
  if !prompt { return AXIsProcessTrusted() }
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  return AXIsProcessTrustedWithOptions(opts)
}

func runPermissions(prompt: Bool) {
  let ax = axTrusted(prompt: prompt)
  var screen = CGPreflightScreenCaptureAccess()
  if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
  emit(["screen": screen, "ax": ax])
}

// MARK: - monitor (bare double-⌘)

func runMonitor(debug: Bool = false) {
  // Global monitors only deliver inside a real NSApplication event loop —
  // RunLoop.main.run() is not enough. Policy .prohibited: no Dock icon.
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)
  let window = 0.4  // max seconds between the taps' edges
  // 0 idle · 1 first ⌘ down · 2 first tap done · 3 second ⌘ down
  var stage = 0
  var last: TimeInterval = 0

  // Any real keystroke means a chord (⌘C etc.) — never a trigger.
  NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { ev in
    if debug { emit(["debug": "keyDown", "code": ev.keyCode]) }
    stage = 0
  }
  NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { ev in
    let flags = ev.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let now = ProcessInfo.processInfo.systemUptime
    if debug { emit(["debug": "flags", "raw": flags.rawValue, "stage": stage]) }
    if flags == .command {
      stage = (stage == 2 && now - last <= window) ? 3 : 1
      last = now
    } else if flags.isEmpty {
      switch stage {
      case 1 where now - last <= window: stage = 2
      case 3 where now - last <= window:
        stage = 0
        emit(["event": "hotkey"])
      default: stage = 0
      }
      last = now
    } else {
      stage = 0  // another modifier joined — not a bare tap
    }
  }
  emit(["event": "ready", "ax": AXIsProcessTrusted()])
  app.run()
}

// MARK: - capture: window pick

struct TargetWindow {
  let windowID: CGWindowID
  let pid: pid_t
  let appName: String
  let title: String
}

func frontmostWindow(excluding pids: Set<pid_t>) -> TargetWindow? {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  // The list is front-to-back; the first ordinary-layer window wins.
  for info in list {
    guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
    guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, !pids.contains(pid) else {
      continue
    }
    if let alpha = info[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
    guard let b = info[kCGWindowBounds as String] as? [String: CGFloat],
      (b["Width"] ?? 0) >= 80, (b["Height"] ?? 0) >= 60
    else { continue }
    guard let num = info[kCGWindowNumber as String] as? UInt32 else { continue }
    return TargetWindow(
      windowID: CGWindowID(num),
      pid: pid,
      appName: info[kCGWindowOwnerName as String] as? String ?? "Unknown",
      title: info[kCGWindowName as String] as? String ?? "")
  }
  return nil
}

// MARK: - capture: screenshot

@available(macOS 14.0, *)
func screenshot(windowID: CGWindowID, to path: String) -> String? {
  var out: String? = "screenshot-failed"
  let sem = DispatchSemaphore(value: 0)
  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, err in
    guard let win = content?.windows.first(where: { $0.windowID == windowID }) else {
      out = "window-gone: \(err?.localizedDescription ?? "not in shareable content")"
      sem.signal()
      return
    }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let config = SCStreamConfiguration()
    let scale = CGFloat(filter.pointPixelScale)
    config.width = Int(filter.contentRect.width * scale)
    config.height = Int(filter.contentRect.height * scale)
    config.showsCursor = false
    config.captureResolution = .best
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, err in
      defer { sem.signal() }
      guard let image else {
        out = "capture-failed: \(err?.localizedDescription ?? "no image")"
        return
      }
      let rep = NSBitmapImageRep(cgImage: image)
      guard let png = rep.representation(using: .png, properties: [:]) else {
        out = "png-encode-failed"
        return
      }
      do {
        try png.write(to: URL(fileURLWithPath: path))
        out = nil
      } catch { out = "write-failed: \(error.localizedDescription)" }
    }
  }
  _ = sem.wait(timeout: .now() + 10)
  return out
}

// MARK: - capture: accessibility text

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
    let arr = v as? [AXUIElement]
  else { return [] }
  return arr
}

let textCapBytes = 200_000
let nodeCap = 30_000

/// Depth-first walk collecting every visible string the tree exposes,
/// in tree order (≈ reading order), deduped, capped at ~200 KB.
func collectText(root: AXUIElement) -> String {
  var lines: [String] = []
  var seen = Set<String>()
  var bytes = 0
  var visited = 0
  var stack: [(AXUIElement, String)] = [(root, "")]
  while bytes < textCapBytes, visited < nodeCap, let (el, context) = stack.popLast() {
    visited += 1
    var own: [String] = []
    if axString(el, kAXRoleAttribute) != "AXSecureTextField" {
      for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
        guard let s = axString(el, attr as String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          s.count > 1
        else { continue }
        own.append(s)
        // A container's title/value usually aggregates its children's text —
        // skip anything the nearest text-bearing ancestor already said.
        guard !context.contains(s), seen.insert(s).inserted else { continue }
        lines.append(s)
        bytes += s.utf8.count + 1
      }
    }
    // popLast is LIFO — push reversed to keep document order.
    let childContext = own.isEmpty ? context : own.joined(separator: "\n")
    stack.append(contentsOf: axChildren(el).reversed().map { ($0, childContext) })
  }
  return lines.joined(separator: "\n")
}

func axWindowElement(app: AXUIElement, title: String) -> AXUIElement {
  for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, attr as CFString, &v) == .success, let v,
      CFGetTypeID(v) == AXUIElementGetTypeID()
    {
      return (v as! AXUIElement)
    }
  }
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success,
    let wins = v as? [AXUIElement]
  {
    if let match = wins.first(where: { axString($0, kAXTitleAttribute) == title }) { return match }
    if let first = wins.first { return first }
  }
  return app
}

let thinThreshold = 200

func axText(pid: pid_t, windowTitle: String) -> (text: String, thin: Bool) {
  let app = AXUIElementCreateApplication(pid)
  // Chromium/Electron apps only build their AX tree when this attribute is
  // set, and take a few seconds the first time. Native apps reject the set
  // (their tree is always live), so they get a single immediate walk.
  let chromium =
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    == .success
  var best = ""
  for wait: UInt32 in chromium ? [0, 500_000, 1_000_000, 1_500_000, 3_000_000] : [0] {
    usleep(wait)
    let text = collectText(root: axWindowElement(app: app, title: windowTitle))
    // Stop once the tree stops growing and has real content.
    if text.utf8.count <= best.utf8.count && best.utf8.count >= thinThreshold { break }
    if text.utf8.count > best.utf8.count { best = text }
  }
  return (best, best.utf8.count < thinThreshold)
}

// MARK: - capture

func runCapture(excludePids: Set<pid_t>, out: String) {
  guard #available(macOS 14.0, *) else { fail("macos-version") }
  guard CGPreflightScreenCaptureAccess() else { fail("screen-permission") }
  guard let win = frontmostWindow(excluding: excludePids) else { fail("no-window") }
  if let err = screenshot(windowID: win.windowID, to: out) { fail("screenshot", err) }
  var text = ""
  var thin = true
  if AXIsProcessTrusted() {
    (text, thin) = axText(pid: win.pid, windowTitle: win.title)
  }
  emit([
    "appName": win.appName,
    "windowTitle": win.title,
    "text": text,
    "thin": thin,
  ])
}

// MARK: - main

var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage", "monitor | capture | permissions") }
args.removeFirst()

func flagValue(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

switch cmd {
case "monitor":
  runMonitor(debug: args.contains("--debug"))
case "permissions":
  runPermissions(prompt: args.contains("--prompt"))
case "capture":
  guard let out = flagValue("--out") else { fail("usage", "capture --exclude-pids 1,2 --out p.png") }
  let pids = Set((flagValue("--exclude-pids") ?? "").split(separator: ",").compactMap { pid_t($0) })
  runCapture(excludePids: pids, out: out)
case "axdump":
  // Debug: the AX-text half of capture alone, against a pid.
  guard let pidStr = flagValue("--pid"), let pid = pid_t(pidStr) else {
    fail("usage", "axdump --pid N")
  }
  if let wait = flagValue("--wait").flatMap(Double.init) {
    let app = AXUIElementCreateApplication(pid)
    let rc = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    Thread.sleep(forTimeInterval: wait)
    let text = collectText(root: axWindowElement(app: app, title: flagValue("--title") ?? ""))
    emit(["setRC": rc.rawValue, "bytes": text.utf8.count, "text": String(text.prefix(500))])
    exit(0)
  }
  let (text, thin) = axText(pid: pid, windowTitle: flagValue("--title") ?? "")
  emit(["text": text, "thin": thin, "bytes": text.utf8.count])
default:
  fail("usage", "unknown subcommand \(cmd)")
}
