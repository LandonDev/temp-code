#if canImport(ScreenCaptureKit)

import AppKit
import Capture
import QuartzCore

/// The proof's own window: an 800×600 pt titled window with a white field, a 20×20 pt red marker
/// at a known content point, "Capture scene 4821" at 36 pt, and per scene a blinking caret, a
/// turning spinner, a 400×300 pt block (repainted or moving) or a generated busy image.
/// Shown with `orderFrontRegardless`: it never takes focus.
@MainActor final class SceneWindow {
    /// Content points, top-left origin.
    static let size = CGSize(width: 800, height: 600)
    static let marker = CGRect(x: 100, y: 100, width: 20, height: 20)
    static let phrase = "Capture scene 4821"
    static let phraseOrigin = CGPoint(x: 100, y: 150)
    static let caret = CGRect(x: 520, y: 162, width: 2, height: 18)
    static let spinner = CGRect(x: 700, y: 60, width: 24, height: 24)
    static let block = CGRect(x: 200, y: 260, width: 400, height: 300)

    let window: InertWindow
    let view: SceneView
    private var timers: [Timer] = []

    init(title: String = "Capture scene", origin: CGPoint? = nil, screen: NSScreen = Screens.primary) {
        let visible = screen.visibleFrame
        let frameOrigin = origin ?? CGPoint(x: visible.minX + 80, y: visible.maxY - Self.size.height - 120)
        window = InertWindow(
            contentRect: CGRect(origin: frameOrigin, size: Self.size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.collectionBehavior = [.managed]
        window.colorSpace = .sRGB
        window.setFrameOrigin(window.frameRect(forContentRect: CGRect(origin: frameOrigin, size: Self.size)).origin)
        view = SceneView(frame: CGRect(origin: .zero, size: Self.size))
        window.contentView = view
    }

    var windowID: UInt32 { UInt32(window.windowNumber) }

    func show() {
        window.orderFrontRegardless()
        view.display()
    }

    func close() {
        stopAll()
        window.orderOut(nil)
        window.close()
    }

    /// The window frame in global CG points (top-left origin), from the window server.
    var cgFrame: CGRect? { LiveWindows.bounds(windowID) }

    /// A content point (top-left origin) in global CG points.
    func screenPoint(content point: CGPoint) -> CGPoint {
        let inView = CGPoint(x: point.x, y: view.bounds.height - point.y)
        let inWindow = view.convert(inView, to: nil)
        let cocoa = window.convertPoint(toScreen: inWindow)
        return CGPoint(x: cocoa.x, y: Screens.primary.frame.maxY - cocoa.y)
    }

    var markerCentre: CGPoint { screenPoint(content: CGPoint(x: Self.marker.midX, y: Self.marker.midY)) }

    /// A content rect in window points (the shot's space before scaling), using the live frame.
    func windowPoints(content rect: CGRect) -> CGRect? {
        guard let frame = cgFrame else { return nil }
        let origin = screenPoint(content: rect.origin)
        return CGRect(x: origin.x - frame.minX, y: origin.y - frame.minY, width: rect.width, height: rect.height)
    }

    /// Resizes the content to `size` points, keeping the top-left corner.
    func resize(to size: CGSize) {
        var frame = window.frame
        let content = window.contentRect(forFrameRect: frame)
        let top = frame.maxY
        frame.size.width += size.width - content.width
        frame.size.height += size.height - content.height
        frame.origin.y = top - frame.height
        window.setFrame(frame, display: true)
        view.layoutDynamic()
    }

    /// Moves the window so its frame's top-left sits at a global CG point.
    func move(cgTopLeft point: CGPoint) {
        let cocoaTop = Screens.primary.frame.maxY - point.y
        window.setFrameTopLeftPoint(CGPoint(x: point.x, y: cocoaTop))
    }

    // MARK: Scene content

    func stopAll() {
        for timer in timers { timer.invalidate() }
        timers = []
        view.setCaret(false)
        view.setSpinner(nil)
        view.setBlock(nil)
        view.setBusy(nil)
    }

    func blinkCaret() {
        var on = true
        view.setCaret(true)
        every(0.5) { [view] in
            on.toggle()
            view.setCaret(on)
        }
    }

    func spin() {
        var angle = 0.0
        view.setSpinner(angle)
        every(1.0 / 12) { [view] in
            angle -= .pi / 6
            view.setSpinner(angle)
        }
    }

    /// Paints the block in one of a few colours; returns mach_absolute_time just after the paint.
    @discardableResult
    func paintBlock(_ index: Int, at x: Double = SceneWindow.block.minX) -> UInt64 {
        view.setBlock(Palette.block[index % Palette.block.count], x: x)
        return mach_absolute_time()
    }

    /// The block sliding 20 pt every 100 ms, back and forth.
    func moveBlock() {
        var step = 0
        paintBlock(0, at: 0)
        every(0.1) { [weak self] in
            step += 1
            let phase = step % 40
            let x = Double(phase < 20 ? phase : 40 - phase) * 20
            self?.paintBlock(0, at: x)
        }
    }

    func showBusy(shifting: Bool) {
        var offset = 0
        view.setBusy(0)
        guard shifting else { return }
        every(0.1) { [view] in
            offset = (offset + 7) % 180
            view.setBusy(Double(offset))
        }
    }

    private func every(_ interval: TimeInterval, _ body: @escaping @MainActor () -> Void) {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in
            MainActor.assumeIsolated { body() }
        }
        RunLoop.main.add(timer, forMode: .common)
        timers.append(timer)
    }
}

enum Palette {
    static let block: [CGColor] = [
        CGColor(srgbRed: 0.10, green: 0.45, blue: 0.85, alpha: 1),
        CGColor(srgbRed: 0.10, green: 0.70, blue: 0.35, alpha: 1),
        CGColor(srgbRed: 0.95, green: 0.65, blue: 0.10, alpha: 1),
        CGColor(srgbRed: 0.55, green: 0.25, blue: 0.75, alpha: 1),
    ]
    /// The occluder's grey, tinted so text antialiasing never matches it.
    static let grey = (r: 110, g: 120, b: 130)
}

enum Screens {
    /// The screen holding the menu bar: global CG origin.
    static var primary: NSScreen { NSScreen.screens[0] }

    /// The screen whose right edge is furthest right: nothing is past it.
    static var rightmost: NSScreen { NSScreen.screens.max { $0.frame.maxX < $1.frame.maxX } ?? primary }

    /// A global CG rect as a Cocoa rect.
    static func cocoa(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: primary.frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// The scene's content. Static parts are drawn; the moving parts are layers whose changes are
/// made with implicit animation off, so each change is one compositor update.
final class SceneView: NSView {
    private let caretLayer = CALayer()
    private let spinnerLayer = CAShapeLayer()
    private let blockLayer = CALayer()
    private let busyLayer = CALayer()
    private var blockX = SceneWindow.block.minX
    private var busyOffset = 0.0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        guard let root = layer else { return }
        caretLayer.backgroundColor = CGColor(gray: 0, alpha: 1)
        spinnerLayer.fillColor = nil
        spinnerLayer.strokeColor = CGColor(gray: 0.3, alpha: 1)
        spinnerLayer.lineWidth = 3
        spinnerLayer.lineCap = .round
        let path = CGMutablePath()
        path.addArc(center: CGPoint(x: 12, y: 12), radius: 9, startAngle: 0, endAngle: .pi * 1.5, clockwise: false)
        spinnerLayer.path = path
        busyLayer.contents = BusyImage.shared
        busyLayer.contentsGravity = .resize
        for sublayer in [blockLayer, busyLayer, caretLayer, spinnerLayer] {
            sublayer.isHidden = true
            sublayer.actions = ["position": NSNull(), "bounds": NSNull(), "hidden": NSNull(), "backgroundColor": NSNull(), "transform": NSNull(), "frame": NSNull(), "contents": NSNull()]
            root.addSublayer(sublayer)
        }
        layoutDynamic()
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1).setFill()
        bounds.fill()
        NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1).setFill()
        flip(SceneWindow.marker).fill()
        let text = NSAttributedString(string: SceneWindow.phrase, attributes: [
            .font: NSFont.systemFont(ofSize: 36),
            .foregroundColor: NSColor.black,
        ])
        let size = text.size()
        text.draw(at: CGPoint(x: SceneWindow.phraseOrigin.x, y: bounds.height - SceneWindow.phraseOrigin.y - size.height))
    }

    /// A content rect (top-left origin) in the view's own bottom-left coordinates.
    func flip(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: bounds.height - rect.maxY, width: rect.width, height: rect.height)
    }

    func layoutDynamic() {
        withoutAnimation {
            caretLayer.frame = flip(SceneWindow.caret)
            spinnerLayer.frame = flip(SceneWindow.spinner)
            var block = SceneWindow.block
            block.origin.x = blockX
            blockLayer.frame = flip(block)
            busyLayer.frame = CGRect(x: -busyOffset, y: -busyOffset * 0.6, width: bounds.width + 200, height: bounds.height + 150)
        }
        needsDisplay = true
    }

    func setCaret(_ on: Bool) {
        withoutAnimation { caretLayer.isHidden = !on }
    }

    func setSpinner(_ angle: Double?) {
        withoutAnimation {
            spinnerLayer.isHidden = angle == nil
            spinnerLayer.setAffineTransform(CGAffineTransform(rotationAngle: angle ?? 0))
        }
    }

    func setBlock(_ color: CGColor?, x: Double = SceneWindow.block.minX) {
        blockX = x
        withoutAnimation {
            blockLayer.isHidden = color == nil
            if let color { blockLayer.backgroundColor = color }
            var block = SceneWindow.block
            block.origin.x = x
            blockLayer.frame = flip(block)
        }
        CATransaction.flush()
    }

    func setBusy(_ offset: Double?) {
        busyOffset = offset ?? 0
        withoutAnimation {
            busyLayer.isHidden = offset == nil
            busyLayer.frame = CGRect(x: -busyOffset, y: -busyOffset * 0.6, width: bounds.width + 200, height: bounds.height + 150)
        }
        CATransaction.flush()
    }

    private func withoutAnimation(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }
}

/// The plain grey window the occlusion scenes put over a target: titled "TempCode capture proof".
@MainActor final class GreyWindow {
    let window: InertWindow

    init() {
        window = InertWindow(contentRect: CGRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "TempCode capture proof"
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = CGColor(srgbRed: CGFloat(Palette.grey.r) / 255, green: CGFloat(Palette.grey.g) / 255, blue: CGFloat(Palette.grey.b) / 255, alpha: 1)
        window.contentView = view
    }

    /// Covers a window whole (its frame, title bar included, a little past each edge), ordered
    /// just above it at the proof's level below `.normal`.
    func cover(_ rect: CGRect, above target: UInt32) {
        window.setFrame(Screens.cocoa(rect.insetBy(dx: -4, dy: -4)), display: true)
        window.orderFrontRegardless()
        window.order(.above, relativeTo: Int(target))
    }

    var windowID: UInt32 { UInt32(window.windowNumber) }

    func hide() {
        window.orderOut(nil)
    }
}

/// Every window the proof shows, in both its processes: it never becomes key or main, takes no
/// mouse event, sits one level below `.normal` so it never covers the person's own windows, and
/// keeps whatever frame it is given (scene 7 puts it half past a display's edge). The proof shows
/// it with `orderFrontRegardless` and never activates.
final class InertWindow: NSWindow {
    static let level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        isReleasedWhenClosed = false
        ignoresMouseEvents = true
        level = Self.level
        hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

/// Smooth colour noise over gradients, generated here: photographic for a JPEG encoder, never a
/// file from the person's disk.
enum BusyImage {
    @MainActor static let shared: CGImage = make(width: 2000, height: 1500)

    static func make(width: Int, height: Int) -> CGImage {
        var generator = Seeded(seed: 0x7319_4821)
        struct Octave { let cell: Int; let weight: Double; let grid: [Double]; let columns: Int }
        let octaves: [Octave] = [(240, 0.42), (60, 0.26), (14, 0.18), (3, 0.14)].map { cell, weight in
            let columns = width / cell + 2, rows = height / cell + 2
            return Octave(cell: cell, weight: weight, grid: (0..<(columns * rows * 3)).map { _ in Double(generator.next() % 1000) / 1000 }, columns: columns)
        }
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                var rgb = [Double(x) / Double(width) * 0.3, Double(y) / Double(height) * 0.25, 0.2]
                for octave in octaves {
                    let fx = Double(x) / Double(octave.cell), fy = Double(y) / Double(octave.cell)
                    let cx = Int(fx), cy = Int(fy)
                    let tx = fx - Double(cx), ty = fy - Double(cy)
                    let sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
                    for channel in 0..<3 {
                        func at(_ gx: Int, _ gy: Int) -> Double { octave.grid[(gy * octave.columns + gx) * 3 + channel] }
                        let top = at(cx, cy) * (1 - sx) + at(cx + 1, cy) * sx
                        let bottom = at(cx, cy + 1) * (1 - sx) + at(cx + 1, cy + 1) * sx
                        rgb[channel] += (top * (1 - sy) + bottom * sy) * octave.weight * 0.85
                    }
                }
                let index = (y * width + x) * 4
                bytes[index] = UInt8(min(255, max(0, rgb[0] * 255)))
                bytes[index + 1] = UInt8(min(255, max(0, rgb[1] * 255)))
                bytes[index + 2] = UInt8(min(255, max(0, rgb[2] * 255)))
            }
        }
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
        )!
    }

    struct Seeded {
        var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }
}

#endif
