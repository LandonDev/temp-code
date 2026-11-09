#if canImport(ScreenCaptureKit)

import AppKit
import Capture
import ComputerCore
import ComputerProtocol
import Foundation
import os
@preconcurrency import ScreenCaptureKit

/// The scenes of plan §10, in the order they run. Each prints one line per check.
@MainActor final class Proof {
    let out: URL
    let report: Report
    let trace = TraceLog()
    let capture: ScreenCaptureKitCapture
    private(set) var scene: SceneWindow!
    let grey = GreyWindow()
    private var target: TargetProcess?
    private var counter = 0
    private var firstShotMs: Double?
    /// Scene 0's verdict on the caret's dirty rects: true when they are fine (the caret's own rect).
    private var fineDirty: Bool?
    private var cpu: [String: Cpu.Span] = [:]

    /// `only`: run just these scenes; `screen`: the index of the NSScreen the scene window opens on.
    let only: Set<String>?
    let screenIndex: Int?

    init(out: URL, only: Set<String>? = nil, screen: Int? = nil) {
        self.out = out
        self.only = only
        self.screenIndex = screen
        report = Report(out: out)
        let trace = trace
        capture = ScreenCaptureKitCapture(log: { print("     log: \($0)") }, trace: { trace.record($0) })
    }

    func run() async -> Int32 {
        let granted = ScreenRecordingAccess.granted()
        report.check("19", "Screen Recording granted", granted, granted ? "CGPreflightScreenCaptureAccess() is true for this process" : "the grant is off: stopping before any ScreenCaptureKit call, and never prompting")
        guard granted else {
            try? report.write()
            return 2
        }
        do {
            try FileManager.default.createDirectory(at: out.appendingPathComponent("frames"), withIntermediateDirectories: true)
            target = try await TargetProcess.launch()
            let screen = screenIndex.flatMap { NSScreen.screens.indices.contains($0) ? NSScreen.screens[$0] : nil } ?? Screens.primary
            scene = SceneWindow(screen: screen)
            scene.show()
            await pause(500)
            report.measure("setup", "screens", NSScreen.screens.map { ["frame": $0.frame, "scale": Double($0.backingScaleFactor)] })
            report.measure("setup", "sceneCovered", coveredShare(scene.cgFrame ?? .zero))
            report.note(String(format: "the scene window is %.0f%% covered by other windows", coveredShare(scene.cgFrame ?? .zero) * 100))
            if case .success(let api) = PrivateSpaces.load() {
                let spaces = PrivateSpaces.displays(api).map { ["display": $0.display, "current": $0.current, "spaces": $0.spaces.map { [$0.id, $0.type] }] as [String: Any] }
                report.measure("setup", "spaces", spaces)
            }
            report.measure("setup", "sceneWindow", ["id": Int(scene.windowID), "frame": scene.cgFrame ?? .zero])
            report.measure("setup", "targetWindow", ["id": Int(target!.windowID), "frame": target!.frame ?? .zero, "pid": Int(target!.process.processIdentifier)])
            await pause(800)
        } catch {
            report.check("setup", "scratch windows", false, "\(error)")
            await cleanup()
            try? report.write()
            return 1
        }
        let scenes: [(String, () async throws -> Void)] = [
            ("1", scene1), ("2", scene2), ("0", scene0), ("3", scene3), ("4", scene4), ("5", scene5),
            ("6", scene6), ("7", scene7), ("8", scene8), ("9", scene9), ("10", scene10),
            ("12", scene12), ("13", scene13), ("14", scene14), ("15", scene15), ("16", scene16), ("13b", scene13b),
            ("11", scene11), ("17", scene17), ("18", scene18),
        ]
        for (name, body) in scenes where only?.contains(name) ?? true {
            print("---- scene \(name)")
            do {
                try await body()
            } catch {
                report.check(name, "scene ran", false, "threw \(error)")
            }
            scene.stopAll()
            grey.hide()
        }
        await cleanup()
        do { try report.write() } catch { print("FAIL report.json: \(error)") }
        return report.failed ? 1 : 0
    }

    private func cleanup() async {
        scene?.close()
        grey.hide()
        await target?.kill()
    }

    // MARK: Helpers

    private func stem(_ action: String) throws -> String {
        counter += 1
        return try ShotNaming.stem(dataDir: out.path, session: "proof", counter: counter, action: action)
    }

    struct Taken {
        let shot: Shot
        let image: CGImage
        let bitmap: Bitmap
        let ms: Double
    }

    private func shot(_ window: UInt32, _ action: String, maxEdge: Int = 1280, region: CGRect? = nil, format: ShotFormat? = nil, using capture: ScreenCaptureKitCapture? = nil) async throws -> Taken {
        let path = try stem(action)
        let rect = region.map { Rect(x: Double($0.minX), y: Double($0.minY), w: Double($0.width), h: Double($0.height)) }
        let (shot, ms) = try await timed { try await (capture ?? self.capture).screenshot(windowID: window, maxEdge: maxEdge, regionPoints: rect, format: format, to: path) }
        guard let image = Images.load(shot.path), let bitmap = Bitmap(image: image) else { throw ProofError("\(shot.path) does not decode") }
        return Taken(shot: shot, image: image, bitmap: bitmap, ms: ms)
    }

    private func describe(_ shot: Shot) -> [String: Any] {
        ["path": shot.path, "format": shot.format.rawValue, "width": shot.width, "height": shot.height, "bytes": shot.bytes, "scale": shot.scale, "blank": shot.blank, "frame": [shot.window.frame.x, shot.window.frame.y, shot.window.frame.w, shot.window.frame.h]]
    }

    private func aspectError(_ width: Int, _ height: Int, _ frame: CGRect) -> Double {
        let image = Double(width) / Double(height), window = Double(frame.width / frame.height)
        return abs(image - window) / window
    }

    /// Window ids on screen, front to back.
    private func onScreenOrder() -> [UInt32] {
        (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    }

    /// The share of a frame other apps' on-screen windows above layer 0 cover (a 16 pt grid).
    private func coveredShare(_ frame: CGRect) -> Double {
        let mine = getpid()
        let others = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { info -> CGRect? in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != mine, ((info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0) >= 0,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: bounds as CFDictionary)
        }
        guard frame.width > 0, frame.height > 0 else { return 0 }
        var covered = 0, all = 0
        for y in stride(from: frame.minY + 8, to: frame.maxY, by: 16) {
            for x in stride(from: frame.minX + 8, to: frame.maxX, by: 16) {
                all += 1
                if others.contains(where: { $0.contains(CGPoint(x: x, y: y)) }) { covered += 1 }
            }
        }
        return Double(covered) / Double(max(all, 1))
    }

    private func scWindow(_ id: UInt32) async throws -> SCWindow {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == id }) else { throw ProofError("window \(id) is not shareable") }
        return window
    }

    private var pointPixelScale: Double { Double(scene.window.backingScaleFactor) }

    private func saveFrame(_ frame: Frame, _ name: String) {
        try? frame.jpeg.write(to: out.appendingPathComponent("frames/\(name).jpg"))
    }

    // MARK: 1. The target, occluded

    private func scene1() async throws {
        guard let target, let frame = target.frame else { throw ProofError("no target window") }
        grey.cover(frame, above: target.windowID)
        await pause(700)
        let order = onScreenOrder()
        let above = (order.firstIndex(of: grey.windowID) ?? .max) < (order.firstIndex(of: target.windowID) ?? .max)
        report.measure("1", "greyAboveTarget", above)
        report.check("1", "the grey window covers the target", above && grey.window.frame.contains(Screens.cocoa(frame)), "grey \(grey.window.frame) over the target \(Screens.cocoa(frame)), above it: \(above)")
        let first = try await shot(target.windowID, "target-first")
        firstShotMs = first.ms
        report.measure("1", "firstShot", describe(first.shot).merging(["ms": first.ms]) { $1 })
        let warm = try await shot(target.windowID, "target-occluded")
        report.measure("1", "warmShot", describe(warm.shot).merging(["ms": warm.ms]) { $1 })
        let ocr = Ocr.finds(TargetProcess.phrase, in: warm.image)
        report.measure("1", "ocr", ocr.lines)
        report.check("1", "probe phrase read under the grey window", ocr.found, ocr.found ? "Vision reads \"\(TargetProcess.phrase)\"" : "Vision read \(ocr.lines)")
        let greyShare = Pixels.share(warm.bitmap, r: Palette.grey.r, g: Palette.grey.g, b: Palette.grey.b)
        report.measure("1", "greyShare", greyShare)
        report.check("1", "no grey in the shot", greyShare < 0.005, String(format: "%.4f%% of pixels are the occluder's grey", greyShare * 100))
        let aspect = aspectError(warm.shot.width, warm.shot.height, frame)
        report.check("1", "aspect equals the CG frame's", aspect < 0.01, String(format: "%dx%d against %.0fx%.0f pt, off by %.3f%%", warm.shot.width, warm.shot.height, frame.width, frame.height, aspect * 100))
        report.check("1", "not blank", !warm.shot.blank, "blank: \(warm.shot.blank), format \(warm.shot.format.rawValue), \(warm.shot.bytes) bytes")
    }

    // MARK: 2. Timings

    private func scene2() async throws {
        guard let target else { throw ProofError("no target window") }
        if let firstShotMs {
            report.check("2", "first shot under 300 ms", firstShotMs < 300, String(format: "%.1f ms (the process's first ScreenCaptureKit call, cold cache)", firstShotMs))
        }
        let fresh = ScreenCaptureKitCapture()
        let (_, freshMs) = try await timed { try await self.shot(target.windowID, "target-fresh-instance", using: fresh) }
        report.measure("2", "firstShotFreshInstanceMs", freshMs)
        report.note(String(format: "a fresh ScreenCaptureKitCapture's first shot (empty window cache): %.1f ms", freshMs))
        for edge in [1280, 2576] {
            var times: [Double] = [], sizes: [Double] = [], formats: [String: Int] = [:]
            var dims = ""
            for index in 0..<10 {
                let taken = try await shot(target.windowID, "target-\(edge)-\(index)", maxEdge: edge)
                times.append(taken.ms)
                sizes.append(Double(taken.shot.bytes))
                formats[taken.shot.format.rawValue, default: 0] += 1
                dims = "\(taken.shot.width)x\(taken.shot.height)"
            }
            report.measure("2", "edge\(edge)", ["ms": Stats.summary(times), "bytes": Stats.summary(sizes), "formats": formats, "size": dims])
            let p50 = Stats.percentile(times, 50), p95 = Stats.percentile(times, 95)
            report.check("2", "warm at \(edge): p50 < 80 ms, p95 < 150 ms", p50 < 80 && p95 < 150, String(format: "p50 %.1f ms, p95 %.1f ms, %@, %@, p50 %.0f KB", p50, p95, dims, formats.description, Stats.percentile(sizes, 50) / 1_000))
        }
        grey.hide()
    }

    // MARK: 0. Probe: what ScreenCaptureKit gives

    private func scene0() async throws {
        scene.stopAll()
        await pause(400)
        guard let frame = scene.cgFrame else { throw ProofError("no scene window") }
        let window = try await scWindow(scene.windowID)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let pps = Double(filter.pointPixelScale)
        let previewSize = ShotGeometry.output(points: frame.size, pointPixelScale: pps, maxEdge: 960)
        let watchSize = ShotGeometry.output(points: frame.size, pointPixelScale: pps, maxEdge: 256)
        let preview = try RawProbe(filter: filter, width: previewSize.width, height: previewSize.height, bgra: true, fps: 10)
        let watch = try RawProbe(filter: filter, width: watchSize.width, height: watchSize.height, bgra: false, fps: 10)
        try await preview.start()
        try await watch.start()
        let start = nowMs()
        await pause(3_000)
        let staticEnd = nowMs()
        var paints: [Double] = []
        for index in 0..<3 {
            scene.paintBlock(index)
            paints.append(nowMs())
            await pause(600)
        }
        scene.view.setBlock(nil)
        await pause(400)
        let caretStart = nowMs()
        scene.blinkCaret()
        await pause(2_600)
        scene.stopAll()
        let caretEnd = nowMs()
        await pause(400)
        preview.measureContent = true
        let resizeAt = nowMs()
        scene.resize(to: CGSize(width: 600, height: 600))
        await pause(1_200)
        scene.resize(to: SceneWindow.size)
        await pause(900)
        preview.measureContent = false
        await preview.stop()
        await watch.stop()

        for (name, probe) in [("preview", preview), ("watch", watch)] {
            let still = probe.all().filter { $0.atMs > start + 600 && $0.atMs < staticEnd && $0.status == SCFrameStatus.complete.rawValue }
            let distinct = Set(still.map(\.hash)).count, top = Set(still.map(\.topHash)).count, rest = Set(still.map(\.restHash)).count
            report.measure("0", "\(name)StaticDistinctBuffers", ["complete": still.count, "distinct": distinct, "distinctTop10pct": top, "distinctRest": rest])
            report.note("\(name): \(still.count) complete static samples, \(distinct) distinct buffers (top 10%: \(top), the rest: \(rest))")
        }
        report.measure("0", "pointPixelScale", pps)
        report.measure("0", "previewConfig", [previewSize.width, previewSize.height])
        report.measure("0", "watchConfig", [watchSize.width, watchSize.height])

        // Idle while static.
        for (name, probe) in [("preview", preview), ("watch", watch)] {
            let still = probe.all().filter { $0.atMs > start + 600 && $0.atMs < staticEnd }
            var statuses: [String: Int] = [:]
            for sample in still { statuses[String(describing: SCFrameStatus(rawValue: sample.status).map { "\($0)" } ?? "\(sample.status)"), default: 0] += 1 }
            let idle = still.filter { $0.status == SCFrameStatus.idle.rawValue }.count
            let complete = still.filter { $0.status == SCFrameStatus.complete.rawValue }.count
            let completes = still.filter { $0.status == SCFrameStatus.complete.rawValue }
            let distinct = Set(completes.map(\.hash)).count
            let wholeDirty = completes.filter { sample in (sample.dirty ?? []).contains { $0.width >= Double(sample.bufferWidth) - 2 || $0.height >= Double(sample.bufferHeight) - 2 } }.count
            report.measure("0", "\(name)StaticStatuses", ["idle": idle, "complete": complete, "all": still.count, "distinctBuffers": distinct, "wholeFrameDirty": wholeDirty])
            let covered = coveredShare(frame)
            report.check("0", "\(name): idle samples while static", idle > 0 && complete <= 1, idle > 0
                ? "\(idle) idle, \(complete) complete of \(still.count) samples in 2.4 s static"
                : String(format: "no idle sample: the window is %.0f%% covered (it sits below .normal) and ScreenCaptureKit marks every sample of a covered window complete, %d of %d with a whole-frame dirty rect, though only %d distinct buffers came; Capture now judges new pixels itself", covered * 100, wholeDirty, complete, distinct),
                finding: idle == 0 && covered > 0.95 && distinct <= 3)
        }

        // Dirty rects on a repaint: which unit are they in?
        guard let block = scene.windowPoints(content: SceneWindow.block) else { throw ProofError("no scene frame") }
        var unitVotes: [String: [String: Int]] = [:]
        for (name, probe, size) in [("preview", preview, previewSize), ("watch", watch, watchSize)] {
            var shown: [[String: Any]] = []
            var present = 0, completes = 0
            for paint in paints {
                let after = probe.all().filter { $0.atMs >= paint && $0.atMs < paint + 450 && $0.status == SCFrameStatus.complete.rawValue }
                completes += after.count
                guard let sample = after.first(where: { !($0.dirty ?? []).isEmpty }), let rects = sample.dirty else { continue }
                present += 1
                let box = rects.dropFirst().reduce(rects[0]) { $0.union($1) }
                let candidates: [(String, CGRect)] = [
                    ("framePixels", scaled(block, size.scale)),
                    ("points", block),
                    ("nativePixels", scaled(block, pps)),
                ]
                let best = candidates.max { iou($0.1, box) < iou($1.1, box) }!
                unitVotes[name, default: [:]][best.0, default: 0] += 1
                shown.append(["rects": rects, "union": box, "candidates": candidates.map { [$0.0, $0.1, iou($0.1, box)] as [Any] }])
            }
            report.measure("0", "\(name)RepaintDirty", shown)
            report.check("0", "\(name): complete samples carry dirty rects", present == paints.count, "\(present) of \(paints.count) repaints had dirty rects (\(completes) complete samples), unit: \(unitVotes[name] ?? [:])")
        }
        report.measure("0", "dirtyUnits", unitVotes)

        // The caret: fine or tile-coarse?
        let caretSamples = watch.all().filter { $0.atMs > caretStart + 300 && $0.atMs < caretEnd && $0.status == SCFrameStatus.complete.rawValue }
        let caretRects = caretSamples.compactMap(\.dirty).flatMap { $0 }
        let watchUnit = unitVotes["watch"]?.max { $0.value < $1.value }?.key ?? "framePixels"
        let toFrame = watchUnit == "points" ? watchSize.scale : watchUnit == "nativePixels" ? watchSize.scale / pps : 1
        let caretAreas = caretRects.map { Double($0.width * $0.height) * toFrame * toFrame }
        fineDirty = !caretRects.isEmpty && caretAreas.allSatisfy { $0 <= 32 }
        report.measure("0", "caretDirty", ["samples": caretSamples.count, "rects": Array(caretRects.prefix(12)), "areasFramePx": Array(caretAreas.prefix(12)), "fine": fineDirty ?? false])
        report.note("caret: \(caretSamples.count) complete samples, rects \(Array(caretRects.prefix(4))) → \(fineDirty == true ? "fine" : "coarse or missing")")

        // contentRect: which factor maps it onto the buffer's pixels?
        let measured = preview.all().filter { $0.atMs > resizeAt && $0.content != nil && $0.contentRect != nil }
        var rows: [[String: Any]] = []
        var errors: [String: [Double]] = [:]
        for sample in measured {
            guard let rect = sample.contentRect, let box = sample.content, rect.width > 0 else { continue }
            let scale = sample.scaleFactor ?? 1, content = sample.contentScale ?? 1
            let factors: [(String, Double)] = [
                ("scaleFactor", scale), ("scaleFactor*contentScale", scale * content), ("scaleFactor/contentScale", scale / content),
                ("contentScale", content), ("1/contentScale", 1 / content), ("1", 1),
            ]
            for (name, factor) in factors {
                let error = abs(Double(rect.width) * factor - Double(box.width)) / Double(box.width) + abs(Double(rect.height) * factor - Double(box.height)) / Double(box.height)
                errors[name, default: []].append(error)
            }
            rows.append(["contentRect": rect, "contentScale": content, "scaleFactor": scale, "buffer": [sample.bufferWidth, sample.bufferHeight], "contentBox": box])
        }
        let ranked = errors.mapValues { $0.reduce(0, +) / Double($0.count) }.sorted { $0.value < $1.value }
        report.measure("0", "contentRectSamples", Array(rows.prefix(10)))
        report.measure("0", "contentRectFactorError", Dictionary(uniqueKeysWithValues: ranked.map { ($0.key, $0.value) }))
        if let best = ranked.first {
            report.check("0", "content rect maps onto the buffer", best.value < 0.02, String(format: "best factor %@ (mean error %.3f) over %d letterboxed samples; %@", best.key, best.value, rows.count, rows.first.map { "first: \($0["contentRect"]!) contentScale \($0["contentScale"]!) scaleFactor \($0["scaleFactor"]!) box \($0["contentBox"]!)" } ?? ""))
            report.measure("0", "contentRectFactor", best.key)
        } else {
            report.check("0", "content rect maps onto the buffer", false, "no measured sample")
        }
    }

    private func scaled(_ rect: CGRect, _ factor: Double) -> CGRect {
        CGRect(x: rect.minX * factor, y: rect.minY * factor, width: rect.width * factor, height: rect.height * factor)
    }

    private func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let inter = a.intersection(b)
        guard !inter.isNull else { return 0 }
        let i = Double(inter.width * inter.height)
        return i / (Double(a.width * a.height) + Double(b.width * b.height) - i)
    }

    // MARK: 3. Coordinates

    private func scene3() async throws {
        await pause(200)
        let taken = try await shot(scene.windowID, "scene-coordinates")
        let origin = CGPoint(x: taken.shot.window.frame.x, y: taken.shot.window.frame.y)
        let expected = CoordinateMapping.pixel(screenPoint: scene.markerCentre, windowOrigin: origin, scale: taken.shot.scale)
        guard let found = Pixels.redCentroid(taken.bitmap) else {
            report.check("3", "marker found", false, "no red pixels in \(taken.shot.path)")
            return
        }
        let dx = found.centre.x - (Double(expected[0]) + 0.5), dy = found.centre.y - (Double(expected[1]) + 0.5)
        report.measure("3", "shot", describe(taken.shot))
        report.measure("3", "marker", ["centroid": found.centre, "pixels": found.count, "expected": expected, "screenPoint": scene.markerCentre])
        report.check("3", "marker within 2 px of CoordinateMapping.pixel", abs(dx) <= 2 && abs(dy) <= 2, String(format: "centroid (%.2f, %.2f), expected pixel %@, off (%.2f, %.2f) px at scale %.4f", found.centre.x, found.centre.y, expected.description, dx, dy, taken.shot.scale))
    }

    // MARK: 4. Zoom

    private func scene4() async throws {
        guard let marker = scene.windowPoints(content: SceneWindow.marker), let frame = scene.cgFrame else { throw ProofError("no scene frame") }
        let region = CGRect(x: marker.midX - 100, y: marker.midY - 75, width: 200, height: 150)
        let taken = try await shot(scene.windowID, "scene-zoom", region: region)
        let geometry = ShotGeometry.zoom(window: frame.size, region: region, pointPixelScale: pointPixelScale, maxEdge: 1280)
        report.measure("4", "shot", describe(taken.shot))
        report.measure("4", "geometry", ["capture": [geometry.capture.width, geometry.capture.height, geometry.capture.scale], "crop": geometry.crop, "region": region])
        report.check("4", "size from ShotGeometry", taken.shot.width == Int(geometry.crop.width) && taken.shot.height == Int(geometry.crop.height), "\(taken.shot.width)x\(taken.shot.height), ShotGeometry crop \(Int(geometry.crop.width))x\(Int(geometry.crop.height))")
        guard let found = Pixels.redCentroid(taken.bitmap) else {
            report.check("4", "marker centred", false, "no red pixels")
            return
        }
        let dx = found.centre.x - Double(taken.shot.width) / 2, dy = found.centre.y - Double(taken.shot.height) / 2
        report.check("4", "marker centred within 2 px", abs(dx) <= 2 && abs(dy) <= 2, String(format: "centroid (%.2f, %.2f) in %dx%d, off (%.2f, %.2f)", found.centre.x, found.centre.y, taken.shot.width, taken.shot.height, dx, dy))
    }

    // MARK: 5. The format rule

    private func scene5() async throws {
        await pause(200)
        let flat = try await shot(scene.windowID, "scene-flat")
        // The same content written as each format by name, to compare like with like.
        let asPNG = try await shot(scene.windowID, "scene-flat-named-png", format: .png)
        let asJPEG = try await shot(scene.windowID, "scene-flat-named-jpeg", format: .jpeg)
        let flatJPEG = asJPEG.shot.bytes
        var whites: [Int: Int] = [:]
        for y in stride(from: asPNG.bitmap.height / 2, to: asPNG.bitmap.height - 4, by: 3) {
            for x in stride(from: asPNG.bitmap.width / 2, to: asPNG.bitmap.width - 4, by: 3) {
                let i = y * asPNG.bitmap.bytesPerRow + x * 4
                let key = Int(asPNG.bitmap.bytes[i]) << 16 | Int(asPNG.bitmap.bytes[i + 1]) << 8 | Int(asPNG.bitmap.bytes[i + 2])
                whites[key, default: 0] += 1
            }
        }
        let fieldColours = whites.sorted { $0.value > $1.value }.prefix(6).map { String(format: "%06x×%d", $0.key, $0.value) }
        report.measure("5", "named", ["png": asPNG.shot.bytes, "jpeg": asJPEG.shot.bytes, "whiteFieldColours": whites.count, "top": fieldColours])
        report.note("named formats: PNG \(asPNG.shot.bytes) B, JPEG \(asJPEG.shot.bytes) B; the white field holds \(whites.count) colours: \(fieldColours)")
        let flatness = PixelStats.flatness(flat.image)
        report.measure("5", "flat", describe(flat.shot).merging(["flatness": flatness, "jpegBytes": flatJPEG, "magic": Images.magic(flat.shot.path)]) { $1 })
        // Where the white field's noise comes from: the same window through each colour space.
        var spaces: [String: Any] = [:]
        let window = try await scWindow(scene.windowID)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let native = (width: Int(Double(window.frame.width) * Double(filter.pointPixelScale)), height: Int(Double(window.frame.height) * Double(filter.pointPixelScale)))
        for (name, space, size) in [
            ("sRGB", CGColorSpace.sRGB as CFString?, (asPNG.shot.width, asPNG.shot.height)), ("displayP3", CGColorSpace.displayP3 as CFString?, (asPNG.shot.width, asPNG.shot.height)),
            ("default", nil, (asPNG.shot.width, asPNG.shot.height)), ("sRGB-native", CGColorSpace.sRGB as CFString?, native), ("default-native", nil, native),
        ] {
            let configuration = SCStreamConfiguration()
            configuration.width = size.0
            configuration.height = size.1
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.captureResolution = .best
            configuration.pixelFormat = kCVPixelFormatType_32BGRA
            if let space { configuration.colorSpaceName = space }
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let png = try ImageEncoding.png(image).count, jpeg = try ImageEncoding.jpeg(image, quality: 0.85).count
            var colours = Set<Int>()
            if let bitmap = Bitmap(image: image) {
                for y in stride(from: bitmap.height / 2, to: bitmap.height - 4, by: 3) {
                    for x in stride(from: bitmap.width / 2, to: bitmap.width - 4, by: 3) {
                        let i = y * bitmap.bytesPerRow + x * 4
                        colours.insert(Int(bitmap.bytes[i]) << 16 | Int(bitmap.bytes[i + 1]) << 8 | Int(bitmap.bytes[i + 2]))
                    }
                }
            }
            spaces[name] = ["png": png, "jpeg": jpeg, "whiteFieldColours": colours.count, "imageSpace": (image.colorSpace?.name as String?) ?? "?"]
            report.note("colour space \(name): PNG \(png) B, JPEG \(jpeg) B, \(colours.count) colours in the white field, image space \((image.colorSpace?.name as String?) ?? "?")")
        }
        report.measure("5", "colourSpaces", spaces)
        let ruleHeld = flat.shot.format == (asPNG.shot.bytes <= flatJPEG ? .png : .jpeg)
        report.check("5", "flat → PNG no larger than its JPEG", flat.shot.format == .png && flat.shot.bytes <= flatJPEG,
            "\(flat.shot.format.rawValue) \(flat.shot.bytes) B, flatness \(String(format: "%.3f", flatness)); its PNG is \(asPNG.shot.bytes) B against a \(flatJPEG) B JPEG, so the rule kept the JPEG (rule applied as written: \(ruleHeld)); a white field with one 36 pt line is smaller as JPEG",
            finding: ruleHeld && asPNG.shot.bytes > flatJPEG)
        if let target {
            let text = try await shot(target.windowID, "target-format")
            let textJPEG = try await shot(target.windowID, "target-format-named-jpeg", format: .jpeg)
            report.measure("5", "flatText", describe(text.shot).merging(["jpegBytes": textJPEG.shot.bytes, "flatness": PixelStats.flatness(text.image), "magic": Images.magic(text.shot.path)]) { $1 })
            report.check("5", "flat text window → PNG no larger than its JPEG", text.shot.format == .png && text.shot.bytes <= textJPEG.shot.bytes, "the target: \(text.shot.format.rawValue) \(text.shot.bytes) B against JPEG \(textJPEG.shot.bytes) B, flatness \(String(format: "%.3f", PixelStats.flatness(text.image)))")
        }
        scene.showBusy(shifting: false)
        await pause(400)
        let busy = try await shot(scene.windowID, "scene-busy")
        let busyFlatness = PixelStats.flatness(busy.image)
        report.measure("5", "busy", describe(busy.shot).merging(["flatness": busyFlatness, "magic": Images.magic(busy.shot.path)]) { $1 })
        report.check("5", "busy → JPEG", busy.shot.format == .jpeg, "\(busy.shot.format.rawValue) \(busy.shot.bytes) B, flatness \(String(format: "%.3f", busyFlatness))")
        let magicOK = Images.magic(flat.shot.path) == flat.shot.format.rawValue && Images.magic(busy.shot.path) == busy.shot.format.rawValue
        report.check("5", "Shot.format matches the magic bytes", magicOK, "flat \(Images.magic(flat.shot.path)), busy \(Images.magic(busy.shot.path))")
    }

    // MARK: 6. Another Space

    private func scene6() async throws {
        let api: PrivateSpaces.Api
        switch PrivateSpaces.load() {
        case .success(let loaded): api = loaded
        case .failure(let reason):
            report.skip("6", "another Space", "SkyLight: \(reason)")
            return
        }
        let other = SceneWindow(title: "Capture scene, another Space")
        other.show()
        defer { other.close() }
        await pause(500)
        let windowNumber = Int(other.windowID)
        let displays = PrivateSpaces.displays(api)
        let currentBefore = displays.map(\.current)
        let on = PrivateSpaces.spaces(of: windowNumber, api)
        guard let from = on.first, let display = displays.first(where: { $0.spaces.contains { $0.id == from } }) else {
            report.skip("6", "another Space", "the window's Space was not found (\(on))")
            return
        }
        guard let target = display.spaces.first(where: { $0.type == 0 && $0.id != display.current }) else {
            report.skip("6", "another Space", "one user Space on this display: nothing to move to")
            return
        }
        PrivateSpaces.move(window: windowNumber, from: from, to: target.id, api)
        await pause(700)
        let now = PrivateSpaces.spaces(of: windowNumber, api)
        report.measure("6", "spaces", ["from": from, "to": target.id, "windowOnAfterMove": now, "display": display.display, "spacesOnDisplay": display.spaces.map(\.id)])
        guard now == [target.id] else {
            PrivateSpaces.move(window: windowNumber, from: target.id, to: from, api)
            report.skip("6", "another Space", "SkyLight did not move the window on this macOS (it is on \(now), asked \(target.id))")
            return
        }
        let taken: Taken
        do {
            taken = try await shot(other.windowID, "scene-other-space")
        } catch {
            PrivateSpaces.move(window: windowNumber, from: target.id, to: from, api)
            throw error
        }
        let currentDuring = PrivateSpaces.displays(api).map(\.current)
        PrivateSpaces.move(window: windowNumber, from: target.id, to: from, api)
        await pause(300)
        let currentAfter = PrivateSpaces.displays(api).map(\.current)
        let ocr = Ocr.finds(SceneWindow.phrase, in: taken.image)
        report.measure("6", "shot", describe(taken.shot).merging(["ocr": ocr.lines]) { $1 })
        report.check("6", "reads the window on another Space", ocr.found && !taken.shot.blank, "OCR \(ocr.found ? "reads \"\(SceneWindow.phrase)\"" : "read \(ocr.lines)"), blank \(taken.shot.blank)")
        report.check("6", "the screen never switched Space", currentBefore == currentDuring && currentBefore == currentAfter, "current Spaces before \(currentBefore), during \(currentDuring), after \(currentAfter)")
    }

    // MARK: 7. Partly off screen

    private func scene7() async throws {
        let screen = Screens.rightmost
        let home = scene.cgFrame!.origin
        let screenTop = Screens.primary.frame.maxY - screen.frame.maxY
        scene.move(cgTopLeft: CGPoint(x: screen.frame.maxX - 400, y: screenTop + 140))
        await pause(600)
        defer { scene.move(cgTopLeft: home) }
        guard let frame = scene.cgFrame else { throw ProofError("no scene frame") }
        let past = frame.maxX - screen.frame.maxX
        report.measure("7", "frame", ["window": frame, "screenRight": screen.frame.maxX, "pastEdge": past])
        let taken = try await shot(scene.windowID, "scene-off-screen")
        let aspect = aspectError(taken.shot.width, taken.shot.height, frame)
        let rightHalf = CGRect(x: Double(taken.shot.width) * 0.75, y: Double(taken.shot.height) * 0.2, width: Double(taken.shot.width) * 0.24, height: Double(taken.shot.height) * 0.75)
        let white = Pixels.share(taken.bitmap, r: 255, g: 255, b: 255, tolerance: 6, area: rightHalf)
        let origin = CGPoint(x: taken.shot.window.frame.x, y: taken.shot.window.frame.y)
        let expected = CoordinateMapping.pixel(screenPoint: scene.markerCentre, windowOrigin: origin, scale: taken.shot.scale)
        let found = Pixels.redCentroid(taken.bitmap)
        report.measure("7", "shot", describe(taken.shot).merging(["whiteShareOffScreenPart": white, "marker": found.map { [$0.centre.x, $0.centre.y] } ?? [], "expected": expected]) { $1 })
        report.check("7", "the whole window, past the edge", past >= 300 && aspect < 0.01 && white > 0.5, String(format: "%.0f pt past the right edge, aspect off %.3f%%, the off-screen quarter %.0f%% white", past, aspect * 100, white * 100))
        let close = found.map { abs($0.centre.x - Double(expected[0]) - 0.5) <= 2 && abs($0.centre.y - Double(expected[1]) - 0.5) <= 2 } ?? false
        report.check("7", "marker found", close, found.map { String(format: "centroid (%.1f, %.1f), expected %@", $0.centre.x, $0.centre.y, expected.description) } ?? "no red pixels")
    }

    // MARK: 8. Resize

    private func scene8() async throws {
        let before = try await shot(scene.windowID, "scene-before-resize")
        scene.resize(to: CGSize(width: 600, height: 700))
        await pause(500)
        defer { scene.resize(to: SceneWindow.size) }
        guard let frame = scene.cgFrame else { throw ProofError("no scene frame") }
        let after = try await shot(scene.windowID, "scene-after-resize")
        let aspect = aspectError(after.shot.width, after.shot.height, frame)
        report.measure("8", "shots", [describe(before.shot), describe(after.shot)])
        report.check("8", "the second shot follows the new size", aspect < 0.01 && before.shot.width * after.shot.height != before.shot.height * after.shot.width, String(format: "%dx%d then %dx%d for a %.0fx%.0f pt frame, off %.3f%%", before.shot.width, before.shot.height, after.shot.width, after.shot.height, frame.width, frame.height, aspect * 100))
    }

    // MARK: 9. The preview stream

    private struct StreamRun {
        let frames: [FrameBox.Got]
        let start: Double
        let end: StreamEndReason
        let startSize: (width: Int, height: Int)
        let span: Cpu.Span
    }

    private func stream(_ window: UInt32, seconds: Int, during: (() async -> Void)? = nil) async throws -> StreamRun {
        let box = FrameBox(autoAck: true)
        let start = nowMs()
        let handle = try await capture.startStream(windowID: window, fps: 4, maxEdge: 960) { box.onFrame($0) }
        box.attach(handle)
        let span = await Cpu.measure {
            if let during { await during() } else { await pause(seconds * 1_000) }
        }
        await handle.stop()
        let end = await handle.ended()
        return StreamRun(frames: box.frames, start: start, end: end, startSize: handle.startSize, span: span)
    }

    private func encodes(_ window: UInt32, since: Double) -> [(bytes: Int, ms: Double)] {
        trace.since(since).compactMap { entry in
            guard case let .previewFrame(id, _, bytes, _, _, ms, _) = entry.event, id == window else { return nil }
            return (bytes, ms)
        }
    }

    private func scene9() async throws {
        // A: the flat scene with the block moving every 100 ms.
        scene.moveBlock()
        await pause(300)
        let flat = try await stream(scene.windowID, seconds: 6)
        let flatWindow = flat.frames.filter { $0.atMs >= flat.start + 1_000 && $0.atMs < flat.start + 6_000 }
        let flatFPS = Double(flatWindow.count) / 5
        let flatEncodes = encodes(scene.windowID, since: flat.start)
        if let first = flat.frames.first { saveFrame(first.frame, "9-flat-first") }
        let sized = flat.frames.allSatisfy { $0.frame.width == flat.startSize.width && $0.frame.height == flat.startSize.height }
        let sizes = Set(flat.frames.map { "\($0.frame.width)x\($0.frame.height)" })
        report.measure("9", "flat", ["fps": flatFPS, "frames": flat.frames.count, "startSize": [flat.startSize.width, flat.startSize.height], "bytes": Stats.summary(flatEncodes.map { Double($0.bytes) }), "encodeMs": Stats.summary(flatEncodes.map(\.ms)), "end": "\(flat.end)", "cpu": span(flat.span)])
        cpu["9-flat"] = flat.span
        report.check("9", "flat: 4 ± 1 fps over 5 s", abs(flatFPS - 4) <= 1, String(format: "%.1f fps, %d frames, p95 %.0f KB, p95 encode %.1f ms", flatFPS, flat.frames.count, Stats.percentile(flatEncodes.map { Double($0.bytes) }, 95) / 1_024, Stats.percentile(flatEncodes.map(\.ms), 95)))
        report.check("9", "frames are the stream's size, unletterboxed", sized, "start size \(flat.startSize.width)x\(flat.startSize.height), frames \(sizes.sorted())")
        scene.stopAll()

        // B: the busy image shifting every 100 ms, the busiest case.
        scene.showBusy(shifting: true)
        await pause(300)
        let busy = try await stream(scene.windowID, seconds: 6)
        let busyWindow = busy.frames.filter { $0.atMs >= busy.start + 1_000 && $0.atMs < busy.start + 6_000 }
        let busyFPS = Double(busyWindow.count) / 5
        let busyEncodes = encodes(scene.windowID, since: busy.start)
        if let first = busy.frames.dropFirst(3).first { saveFrame(first.frame, "9-busy") }
        let bytesP95 = Stats.percentile(busyEncodes.map { Double($0.bytes) }, 95), msP95 = Stats.percentile(busyEncodes.map(\.ms), 95)
        report.measure("9", "busy", ["fps": busyFPS, "frames": busy.frames.count, "bytes": Stats.summary(busyEncodes.map { Double($0.bytes) }), "encodeMs": Stats.summary(busyEncodes.map(\.ms)), "end": "\(busy.end)", "cpu": span(busy.span)])
        cpu["9-busy"] = busy.span
        report.check("9", "busy: 4 ± 1 fps over 5 s", abs(busyFPS - 4) <= 1, String(format: "%.1f fps, %d frames", busyFPS, busy.frames.count))
        let inline = bytesP95 <= 300 * 1_024 && msP95 <= 25
        report.measure("9", "inlineDecision", ["p95Bytes": bytesP95, "p95EncodeMs": msP95, "inline": inline])
        report.check("9", "§6.1: stay inline (p95 ≤ 300 KiB and ≤ 25 ms)", inline, String(format: "busy p95 %.1f KiB, p95 encode %.1f ms at 960 px, 4 fps", bytesP95 / 1_024, msP95), finding: true)
        scene.stopAll()

        // C: a resize mid-stream: frames crop by each sample's content rect, never letterboxed.
        scene.moveBlock()
        await pause(300)
        var resizedAt = 0.0
        let resized = try await stream(scene.windowID, seconds: 0) {
            await pause(1_500)
            resizedAt = nowMs()
            self.scene.resize(to: CGSize(width: 600, height: 600))
            await pause(2_000)
            self.scene.resize(to: SceneWindow.size)
            await pause(1_500)
        }
        var letterboxed: [[String: Any]] = []
        var aspects: [Double] = []
        for got in resized.frames {
            guard let image = Images.load(got.frame.jpeg), let bitmap = Bitmap(image: image) else { continue }
            let edges = Pixels.blackEdges(bitmap)
            aspects.append(Double(got.frame.width) / Double(got.frame.height))
            if edges.values.contains(where: { $0 > 0.5 }) {
                letterboxed.append(["seq": got.frame.seq, "size": [got.frame.width, got.frame.height], "edges": edges])
                saveFrame(got.frame, "9-letterboxed-\(got.frame.seq)")
            }
        }
        if let after = resized.frames.first(where: { $0.atMs > resizedAt + 600 }) { saveFrame(after.frame, "9-after-resize") }
        let samples = trace.since(resizedAt).compactMap { entry -> [String: Any]? in
            guard case let .previewSample(id, _, rect, contentScale, scaleFactor, width, height, crop, taken) = entry.event, id == scene.windowID else { return nil }
            return ["contentRect": rect ?? .zero, "contentScale": contentScale ?? -1, "scaleFactor": scaleFactor, "buffer": [width, height], "crop": crop ?? .zero, "taken": taken]
        }
        guard let frame = scene.cgFrame else { throw ProofError("no scene frame") }
        let narrow = (600.0 / (frame.height - 600 + 600))
        report.measure("9", "resize", ["frames": resized.frames.count, "letterboxed": letterboxed, "aspects": aspects, "samples": Array(samples.prefix(8))])
        let followed = aspects.contains { abs($0 - narrow) / narrow < 0.03 }
        report.check("9", "resize mid-stream: no frame letterboxed", letterboxed.isEmpty && followed, "\(letterboxed.count) of \(resized.frames.count) frames had black edges; a frame took the narrow aspect: \(followed)")
    }

    private func span(_ span: Cpu.Span) -> [String: Any] {
        ["wallMs": span.wallMs, "processMs": span.processMs, "mainThreadMs": span.mainMs, "processShare": span.processShare, "offMainShare": span.offMainShare]
    }

    // MARK: 10. Flow control

    private func scene10() async throws {
        // Moving block, no acks.
        scene.moveBlock()
        await pause(300)
        let box = FrameBox(autoAck: false)
        let start = nowMs()
        let handle = try await capture.startStream(windowID: scene.windowID, fps: 4, maxEdge: 960) { box.onFrame($0) }
        box.attach(handle)
        await pause(8_000)
        let unacked = box.frames
        let events = trace.since(start)
        let pausedAt = events.first { if case let .previewPaused(id) = $0.event { return id == scene.windowID }; return false }?.atMs
        let firstFrameAt = unacked.first?.atMs
        let samplesBeforePause = events.compactMap { entry -> (Double, UInt64)? in
            guard let pausedAt, entry.atMs <= pausedAt, case let .previewSample(id, time, _, _, _, _, _, _, _) = entry.event, id == scene.windowID else { return nil }
            return (entry.atMs, time)
        }
        let samplesWhilePaused = events.filter { entry in
            guard let pausedAt, entry.atMs > pausedAt + 300, case let .previewSample(id, _, _, _, _, _, _, _, _) = entry.event else { return false }
            return id == scene.windowID
        }.count
        let newest = samplesBeforePause.last?.1
        report.check("10", "at most 2 frames out", unacked.count == 2, "\(unacked.count) frames in 8 s with no ack")
        if let pausedAt, let firstFrameAt {
            let after = (pausedAt - firstFrameAt) / 1_000
            report.check("10", "moving: capture stops 5 s after the oldest unacked frame", after >= 4.9 && after <= 6.3 && samplesWhilePaused == 0, String(format: "paused %.2f s after frame 1; %d samples while paused", after, samplesWhilePaused))
        } else {
            report.check("10", "moving: capture stops 5 s after the oldest unacked frame", false, "no pause traced")
        }
        let ackAt = nowMs()
        box.autoAck = true
        box.ack(unacked.last?.frame.seq ?? 2)
        await pause(1_200)
        let after = box.frames.dropFirst(unacked.count)
        let afterEvents = trace.since(ackAt).compactMap { entry -> (Int, UInt64, Double)? in
            guard case let .previewFrame(id, seq, _, _, _, _, time) = entry.event, id == scene.windowID else { return nil }
            return (seq, time, entry.atMs)
        }
        let heldFrame = afterEvents.first
        report.check("10", "the held frame is the newest", heldFrame != nil && heldFrame?.1 == newest, "the frame sent on the ack carries sample \(heldFrame.map { "\($0.1)" } ?? "none"), the newest sample before the pause was \(newest.map { "\($0)" } ?? "none")")
        if let held = after.first { saveFrame(held.frame, "10-held") }
        let fresh = afterEvents.first { machToMs($0.1) > ackAt }
        let freshMs = fresh.map { $0.2 - ackAt }
        report.check("10", "moving: one ack resumes, new pixels within 500 ms", (freshMs ?? .infinity) <= 500, freshMs.map { String(format: "a frame of new pixels %.0f ms after the ack (seq %d)", $0, fresh!.0) } ?? "no new frame")
        report.measure("10", "moving", ["unacked": unacked.count, "pausedAfterMs": pausedAt.flatMap { p in firstFrameAt.map { p - $0 } } ?? -1, "samplesWhilePaused": samplesWhilePaused, "freshAfterAckMs": freshMs ?? -1])
        await handle.stop()
        _ = await handle.ended()
        scene.stopAll()
        await pause(500)

        // A still window: one frame, no ack.
        let stillBox = FrameBox(autoAck: false)
        let stillStart = nowMs()
        let still = try await capture.startStream(windowID: scene.windowID, fps: 4, maxEdge: 960) { stillBox.onFrame($0) }
        stillBox.attach(still)
        await pause(7_500)
        let stillFrames = stillBox.frames
        if stillFrames.count >= 2, let one = Images.load(stillFrames[0].frame.jpeg).flatMap(Bitmap.init(image:)), let two = Images.load(stillFrames[1].frame.jpeg).flatMap(Bitmap.init(image:)) {
            saveFrame(stillFrames[0].frame, "10-still-1")
            saveFrame(stillFrames[1].frame, "10-still-2")
            report.measure("10", "stillSecondFrame", ["gapMs": stillFrames[1].atMs - stillFrames[0].atMs, "differs": Pixels.differenceBox(one, two).map { [$0.minX, $0.minY, $0.width, $0.height] } ?? []])
            report.note("still: a second frame \(Int(stillFrames[1].atMs - stillFrames[0].atMs)) ms after the first; the pixels differ in \(Pixels.differenceBox(one, two).map { "\($0)" } ?? "nothing")")
        }
        let stillPause = trace.since(stillStart).first { if case let .previewPaused(id) = $0.event { return id == scene.windowID }; return false }?.atMs
        if let stillPause, let first = stillFrames.first {
            let after = (stillPause - first.atMs) / 1_000
            // macOS draws its window-sharing badge in the title bar once capture starts, so a still
            // window may send a second frame whose only change is that corner.
            let badgeOnly = stillFrames.count == 2 && {
                guard let one = Images.load(stillFrames[0].frame.jpeg).flatMap(Bitmap.init(image:)), let two = Images.load(stillFrames[1].frame.jpeg).flatMap(Bitmap.init(image:)),
                      let box = Pixels.differenceBox(one, two) else { return false }
                return box.maxX <= 120 && box.maxY <= 40
            }()
            report.check("10", "still: capture stops 5 s after its one unacked frame", (stillFrames.count == 1 || badgeOnly) && after >= 4.9 && after <= 6.3, String(format: "%d frame(s)%@, paused %.2f s after the first", stillFrames.count, badgeOnly ? " (the second only the title bar's sharing badge)" : "", after))
        } else {
            report.check("10", "still: capture stops 5 s after its one unacked frame", false, "\(stillFrames.count) frames, pause traced: \(stillPause != nil)")
        }
        stillBox.autoAck = true
        stillBox.ack(stillFrames.last?.frame.seq ?? 1)
        await pause(400)
        let paintAt = nowMs()
        scene.paintBlock(2)
        await pause(1_000)
        let stillAfter = trace.since(paintAt).compactMap { entry -> Double? in
            guard case let .previewFrame(id, _, _, _, _, _, time) = entry.event, id == scene.windowID, machToMs(time) >= paintAt else { return nil }
            return entry.atMs - paintAt
        }.first
        report.check("10", "still: one ack resumes, new pixels within 500 ms", (stillAfter ?? .infinity) <= 500, stillAfter.map { String(format: "the repaint arrived %.0f ms after it was drawn", $0) } ?? "no frame after the repaint")
        report.measure("10", "still", ["frames": stillFrames.count, "pausedAfterMs": stillPause.flatMap { p in stillFrames.first.map { p - $0.atMs } } ?? -1, "repaintToFrameMs": stillAfter ?? -1])
        await still.stop()
        _ = await still.ended()
    }

    // MARK: 11. Stream end

    private func scene11() async throws {
        guard let target else { throw ProofError("no target") }
        let box = FrameBox(autoAck: true)
        let start = nowMs()
        let handle = try await capture.startStream(windowID: target.windowID, fps: 4, maxEdge: 960) { box.onFrame($0) }
        box.attach(handle)
        await pause(1_200)
        let quitAt = nowMs()
        await target.kill()
        let held = Unchecked(handle)
        let reason = await withTimeout(8) { await held.value.ended() }
        let ended = trace.since(start).first { if case let .previewEnded(id, _, _) = $0.event { return id == target.windowID }; return false }
        let cause = ended.map { entry -> String in
            if case let .previewEnded(_, cause, _) = entry.event { return "\(cause)" }
            return "?"
        } ?? "none"
        report.measure("11", "targetKilled", ["reason": reason.map { "\($0)" } ?? "timeout", "cause": cause, "endedAfterQuitMs": ended.map { $0.atMs - quitAt } ?? -1, "frames": box.frames.count])
        report.check("11", "killing the target process ends the stream as windowClosed", reason == .windowClosed, "ended() gave \(reason.map { "\($0)" } ?? "nothing in 8 s"), from \(cause), \(ended.map { String(format: "%.0f ms after the kill", $0.atMs - quitAt) } ?? "")")

        // The proof's own window closed mid-stream, and a watch on it: first closed but kept (an
        // NSWindow ordered out and still alive, as a window controller keeps a Settings window),
        // then released, so the window server destroys it as it does a document window's.
        var doomed: SceneWindow? = SceneWindow(title: "Capture scene, closing")
        doomed?.show()
        await pause(400)
        let id = doomed!.windowID
        let doomedBox = FrameBox(autoAck: true)
        let doomedStart = nowMs()
        let doomedHandle = try await capture.startStream(windowID: id, fps: 4, maxEdge: 960) { doomedBox.onFrame($0) }
        doomedBox.attach(doomedHandle)
        let signal = try await capture.watch(windowID: id)
        _ = await signal.waitLive(timeout: .seconds(1))
        await pause(800)
        doomed?.close()
        await pause(2_500)
        let keptListed = LiveWindows.bounds(id) != nil
        let endedWhileKept = trace.since(doomedStart).contains { if case let .previewEnded(window, _, _) = $0.event { return window == id }; return false }
        let closeAt = nowMs()
        doomed = nil
        let doomedHeld = Unchecked(doomedHandle)
        let doomedReason = await withTimeout(8) { await doomedHeld.value.ended() }
        if doomedReason == nil { await doomedHandle.stop() }
        await pause(1_500)
        let events = trace.since(doomedStart)
        let previewCause = events.compactMap { entry -> (String, Double)? in
            if case let .previewEnded(window, cause, _) = entry.event, window == id { return ("\(cause)", entry.atMs - closeAt) }
            return nil
        }.first
        let watchCause = events.compactMap { entry -> (String, Double)? in
            if case let .watchStopped(window, cause) = entry.event, window == id { return ("\(cause)", entry.atMs - closeAt) }
            return nil
        }.first
        report.measure("11", "ownWindowOrderedOut", ["stillListedAfter2500ms": keptListed, "streamEnded": endedWhileKept])
        report.note("closed but kept: LiveWindows still lists it after 2.5 s: \(keptListed); the stream ended meanwhile: \(endedWhileKept)")
        report.measure("11", "ownWindowClosed", ["reason": doomedReason.map { "\($0)" } ?? "timeout", "previewCause": previewCause?.0 ?? "none", "previewAfterMs": previewCause?.1 ?? -1, "watchCause": watchCause?.0 ?? "none", "watchAfterMs": watchCause?.1 ?? -1, "watchLive": signal.live])
        report.check("11", "a closed and released window ends its stream as windowClosed", doomedReason == .windowClosed, "ended() gave \(doomedReason.map { "\($0)" } ?? "nothing"), from \(previewCause?.0 ?? "?") after \(Int(previewCause?.1 ?? -1)) ms; the watch stopped from \(watchCause?.0 ?? "?") after \(Int(watchCause?.1 ?? -1)) ms")
    }

    /// The body's answer, or nil after `seconds`; never waits for a body that does not answer.
    private func withTimeout<T: Sendable>(_ seconds: Double, _ body: @escaping @Sendable () async -> T) async -> T? {
        let answered = OSAllocatedUnfairLock(initialState: false)
        return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
            @Sendable func answer(_ value: T?) {
                let first = answered.withLock { done in
                    defer { done = true }
                    return !done
                }
                if first { continuation.resume(returning: value) }
            }
            Task { answer(await body()) }
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                answer(nil)
            }
        }
    }

    // MARK: 12–16, 13b. The watch

    private var signal: (any PixelChangeSignal)?

    private func counted(since: Double, until: Double = .infinity) -> [TraceLog.WatchSeen] {
        trace.watchFrames(scene.windowID, since: since, until: until).filter(\.counted)
    }

    private func scene12() async throws {
        scene.stopAll()
        await pause(500)
        let start = nowMs()
        let signal = try await capture.watch(windowID: scene.windowID)
        let (live, ms) = await timed { await signal.waitLive(timeout: CaptureTuning.baselineWait) }
        self.signal = signal
        report.check("12", "waitLive true within 300 ms, cold", live && ms <= 300, String(format: "waitLive gave %@ after %.0f ms", live ? "true" : "false", ms))
        let watchStart = nowMs()
        let span = await Cpu.measure { await pause(10_000) }
        cpu["12"] = span
        let changes = counted(since: watchStart)
        let frames = trace.watchFrames(scene.windowID, since: start)
        report.measure("12", "watch", ["waitLiveMs": ms, "frames": frames.count, "complete": frames.filter(\.complete).count, "counted": changes.count, "cpu": self.span(span)])
        report.check("12", "static: no counting frame, still live", changes.isEmpty && signal.live && signal.lastChange == 0, "\(changes.count) counted of \(frames.count) frames (\(frames.filter(\.complete).count) complete), live \(signal.live), lastChange \(signal.lastChange)")
    }

    private func keepAlive(_ seconds: Double) async {
        let end = nowMs() + seconds * 1_000
        while nowMs() < end {
            _ = signal?.lastChange
            await pause(500)
        }
    }

    private func scene13() async throws {
        _ = try await capture.watch(windowID: scene.windowID)
        let start = nowMs()
        scene.blinkCaret()
        await keepAlive(10)
        scene.stopAll()
        let frames = trace.watchFrames(scene.windowID, since: start, until: start + 10_000)
        let changes = frames.filter(\.counted)
        let times = changes.map { ($0.atMs - start) / 1_000 }
        let judged = frames.filter(\.complete).compactMap(\.judged).prefix(6).map { Array($0) }
        report.measure("13", "caret", ["counted": changes.count, "at": times, "complete": frames.filter(\.complete).count, "judgedRects": Array(judged), "fineDirty": fineDirty ?? false])
        if fineDirty == true {
            report.check("13", "caret: no counting frame (fine dirty rects)", changes.isEmpty, "\(changes.count) counted over 10 s, at \(times.map { String(format: "%.2f s", $0) })")
        } else {
            report.check("13", "caret: at most 2, in the first 1.5 s (coarse dirty rects)", changes.count <= 2 && times.allSatisfy { $0 <= 1.5 }, "\(changes.count) counted, at \(times.map { String(format: "%.2f s", $0) })")
        }
    }

    private func scene14() async throws {
        _ = try await capture.watch(windowID: scene.windowID)
        await pause(2_500)
        let start = nowMs()
        scene.spin()
        await keepAlive(5)
        scene.stopAll()
        let frames = trace.watchFrames(scene.windowID, since: start, until: start + 5_000)
        let changes = frames.filter(\.counted)
        report.measure("14", "spinner", ["counted": changes.count, "at": changes.map { ($0.atMs - start) / 1_000 }, "complete": frames.filter(\.complete).count, "judgedRects": Array(frames.filter(\.complete).compactMap(\.judged).prefix(4))])
        report.check("14", "spinner: at most 2 counting frames", changes.count <= 2, "\(changes.count) counted of \(frames.filter(\.complete).count) complete frames over 5 s")
    }

    /// Repaints the block `times` times; per repaint the latency to the counting frame.
    /// Per counted repaint: `arrival` paint → signal (end to end), `display` paint → the frame's
    /// display time (the compositor's share), `added` display time → signal (Capture's own).
    private func repaints(_ times: Int, from colour: Int = 0) async -> (counted: Int, arrival: [Double], display: [Double], added: [Double]) {
        var arrival: [Double] = [], display: [Double] = [], added: [Double] = [], counted = 0
        for index in 0..<times {
            let paintedAt = machToMs(scene.paintBlock(colour + index))
            await pause(600)
            _ = signal?.lastChange
            guard let hit = trace.watchFrames(scene.windowID, since: paintedAt - 1).first(where: { $0.counted && $0.displayMs >= paintedAt - 1 }), hit.atMs < paintedAt + 600 else { continue }
            counted += 1
            arrival.append(hit.atMs - paintedAt)
            display.append(hit.displayMs - paintedAt)
            added.append(hit.atMs - hit.displayMs)
        }
        return (counted, arrival, display, added)
    }

    private func scene15() async throws {
        signal = try await capture.watch(windowID: scene.windowID)
        await pause(2_500)
        let result = await repaints(10)
        // Judged: the time Capture adds, from the counting frame's display time to the signal. The
        // end to end (paint → signal) is measured only: under load the compositor delivers a
        // covered window's frames late, and that share is ScreenCaptureKit's, not Capture's.
        let p95 = Stats.percentile(result.added, 95)
        report.measure("15", "repaint", [
            "counted": result.counted, "arrivalMs": Stats.summary(result.arrival), "displayTimeMs": Stats.summary(result.display),
            "captureAddedMs": Stats.summary(result.added), "lastChange": signal?.lastChange ?? 0,
        ])
        report.check("15", "every repaint counted", result.counted == 10, "\(result.counted) of 10")
        report.check("15", "frame → lastChange p95 under 150 ms (Capture's own time)", p95 < 150, String(
            format: "p95 %.1f ms from the counting frame's display time to the signal; end to end p95 %.0f ms (measured, not judged), the frame's display time p95 %.0f ms after the paint",
            p95, Stats.percentile(result.arrival, 95), Stats.percentile(result.display, 95)
        ))
    }

    private func scene16() async throws {
        guard let frame = scene.cgFrame else { throw ProofError("no scene frame") }
        signal = try await capture.watch(windowID: scene.windowID)
        grey.cover(frame, above: scene.windowID)
        await pause(800)
        let result = await repaints(5, from: 1)
        report.measure("16", "covered", ["counted": result.counted, "arrivalMs": Stats.summary(result.arrival)])
        report.check("16", "repaints counted while covered", result.counted == 5, "\(result.counted) of 5 under the grey window, p95 \(Int(Stats.percentile(result.arrival, 95))) ms")
        grey.hide()
    }

    private func scene13b() async throws {
        scene.stopAll()
        signal = try await capture.watch(windowID: scene.windowID)
        _ = await signal?.waitLive(timeout: .seconds(1))
        let start = nowMs()
        var liveAt40 = false
        while nowMs() - start < 40_000 {
            liveAt40 = signal?.live ?? false
            await pause(200)
        }
        let lastRead = nowMs()
        liveAt40 = signal?.live ?? false
        report.check("13b", "still live after 40 s of reads, no watch call", liveAt40, "live: \(liveAt40)")
        var stoppedAt: Double?
        while nowMs() - lastRead < 40_000, stoppedAt == nil {
            await pause(250)
            stoppedAt = trace.since(lastRead).first { if case let .watchStopped(id, .linger) = $0.event { return id == scene.windowID }; return false }?.atMs
        }
        let after = stoppedAt.map { ($0 - lastRead) / 1_000 }
        report.measure("13b", "linger", ["stoppedAfterLastReadS": after ?? -1])
        report.check("13b", "stops 30 s after the reads end", after.map { $0 >= 29.9 && $0 <= 31.5 } ?? false, after.map { String(format: "stopped %.2f s after the last read", $0) } ?? "never stopped")
        signal = nil
    }

    // MARK: 17. Minimized

    private func scene17() async throws {
        scene.paintBlock(0)
        await pause(400)
        let before = try await shot(scene.windowID, "scene-before-minimize")
        scene.window.miniaturize(nil)
        await pause(1_800)
        scene.paintBlock(3)
        await pause(400)
        let minimized = scene.window.isMiniaturized
        let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(scene.windowID)) as? [[String: Any]])?.first ?? [:]
        let onscreen = (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        let scOnScreen = try? await scWindow(scene.windowID).isOnScreen
        let scFrame = try? await scWindow(scene.windowID).frame
        var outcome: [String: Any] = ["isMiniaturized": minimized, "cgIsOnscreen": onscreen, "scIsOnScreen": scOnScreen ?? false, "cgInfo": info.mapValues { "\($0)" }, "liveBounds": LiveWindows.bounds(scene.windowID).map { [$0.minX, $0.minY, $0.width, $0.height] } ?? [], "scFrame": scFrame.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? []]
        do {
            let taken = try await shot(scene.windowID, "scene-minimized")
            let old = Pixels.blockX(taken.bitmap, colour: Palette.block[0]) != nil
            let new = Pixels.blockX(taken.bitmap, colour: Palette.block[3]) != nil
            outcome["shot"] = describe(taken.shot).merging(["showsBlockBefore": old, "showsBlockAfter": new]) { $1 }
            let stale = !taken.shot.blank && old && !new
            report.check("17", "minimized: blank or capture_failed, never stale", taken.shot.blank || (!stale && new), "a \(taken.shot.width)x\(taken.shot.height) image, blank \(taken.shot.blank), shows the pre-minimize block \(old), the repaint while minimized \(new)")
        } catch let failure as ComputerFailure {
            outcome["error"] = ["kind": failure.error.kind.rawValue, "message": failure.error.message]
            report.check("17", "minimized: blank or capture_failed, never stale", failure.error.kind == .captureFailed, "threw \(failure.error.kind.rawValue): \(failure.error.message)")
        }
        outcome["before"] = describe(before.shot)
        report.measure("17", "minimized", outcome)
    }

    // MARK: 18. Cost

    private func scene18() async throws {
        for (name, span) in cpu.sorted(by: { $0.key < $1.key }) {
            report.measure("18", name, self.span(span))
            report.check("18", "\(name): the proof process under 10% of a core", span.processShare <= 0.10, String(format: "%.1f%% of a core (%.1f%% off the main thread, which draws the scene)", span.processShare * 100, span.offMainShare * 100))
        }
    }
}

#endif
