import SwiftUI

/// The git hosts whose mark stands in for a workspace with no icon.
enum GitHost: String {
    case github
    case gitlab
    case bitbucket
}

/// The desktop's host marks (hugeicons GithubIcon and GitlabIcon, stroked
/// at 1.5 in a 24 pt box), drawn as paths so they scale with the row. The
/// stroke follows the text beside it: 1.5 beside regular, 2 beside semibold.
struct HostMark: View {
    let host: GitHost
    var weight: Font.Weight = .regular

    private var lineWidth: CGFloat {
        weight == .semibold || weight == .bold || weight == .heavy || weight == .black ? 2 : 1.5
    }

    var body: some View {
        switch host {
        case .github:
            StrokedPaths(lineWidth: lineWidth, paths: [
                "M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17",
                "M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22"
            ])
        case .gitlab:
            StrokedPaths(lineWidth: lineWidth, paths: [
                "M21.7976 13.0838C21.9702 13.7157 22.0566 14.0317 21.9594 14.3228C21.8621 14.6139 21.6031 14.815 21.0851 15.2172L13.2468 21.3025C12.6478 21.7675 12.3484 22 12 22C11.6516 22 11.3522 21.7675 10.7532 21.3025L2.91487 15.2172C2.39687 14.815 2.13787 14.6139 2.04065 14.3228C1.94343 14.0317 2.02976 13.7157 2.20243 13.0838L5.23081 2L8.08792 8.65441C8.34375 9.25025 8.47166 9.54818 8.72598 9.71557C8.98031 9.88296 9.30503 9.88296 9.95448 9.88296H14.0455C14.695 9.88296 15.0197 9.88296 15.274 9.71557C15.5283 9.54818 15.6563 9.25025 15.9121 8.65441L18.7692 2L21.7976 13.0838Z"
            ])
        case .bitbucket:
            Image(systemName: "bucket")
                .font(.subheadline.weight(weight))
        }
    }
}

/// SVG path strings stroked in a 24-unit box, scaled to the frame.
private nonisolated struct StrokedPaths: Shape {
    let lineWidth: CGFloat
    let paths: [String]

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        var out = Path()
        for d in paths {
            out.addPath(SVGPath.parse(d).applying(CGAffineTransform(scaleX: scale, y: scale)))
        }
        return out.strokedPath(StrokeStyle(lineWidth: lineWidth * scale, lineCap: .round, lineJoin: .round))
    }
}

/// Enough of the SVG path grammar for icon data: M L H V C S Q T A Z, absolute and relative.
nonisolated enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        let tokens = tokenize(d)
        var i = 0
        var current = CGPoint.zero
        var start = CGPoint.zero
        var control: CGPoint?
        var command: Character = "M"

        func next() -> CGFloat {
            defer { i += 1 }
            if i < tokens.count, case .number(let value) = tokens[i] { return value }
            return 0
        }
        func point(_ relative: Bool) -> CGPoint {
            let x = next(), y = next()
            return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        }

        while i < tokens.count {
            if case .command(let c) = tokens[i] {
                command = c
                i += 1
            }
            let relative = command.isLowercase
            var nextControl: CGPoint?
            switch command.uppercased() {
            case "M":
                let p = point(relative)
                path.move(to: p)
                current = p
                start = p
                command = relative ? "l" : "L"
            case "L":
                let p = point(relative)
                path.addLine(to: p)
                current = p
            case "H":
                let x = next()
                current.x = relative ? current.x + x : x
                path.addLine(to: current)
            case "V":
                let y = next()
                current.y = relative ? current.y + y : y
                path.addLine(to: current)
            case "C":
                let c1 = point(relative), c2 = point(relative), p = point(relative)
                path.addCurve(to: p, control1: c1, control2: c2)
                nextControl = c2
                current = p
            case "S":
                let c1 = control.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = point(relative), p = point(relative)
                path.addCurve(to: p, control1: c1, control2: c2)
                nextControl = c2
                current = p
            case "Q":
                let c = point(relative), p = point(relative)
                path.addQuadCurve(to: p, control: c)
                nextControl = c
                current = p
            case "T":
                let c = control.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let p = point(relative)
                path.addQuadCurve(to: p, control: c)
                nextControl = c
                current = p
            case "A":
                let rx = next(), ry = next(), rotation = next(), large = next() != 0, sweep = next() != 0
                let p = point(relative)
                arc(&path, from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = p
            case "Z":
                path.closeSubpath()
                current = start
            default:
                i += 1
            }
            control = nextControl
        }
        return path
    }

    private enum Token {
        case command(Character)
        case number(CGFloat)
    }

    private static func tokenize(_ d: String) -> [Token] {
        var tokens: [Token] = []
        var number = ""
        func flush() {
            if let value = Double(number) { tokens.append(.number(CGFloat(value))) }
            number = ""
        }
        for ch in d {
            if ch.isLetter, ch != "e", ch != "E" {
                flush()
                tokens.append(.command(ch))
            } else if ch == "-" || ch == "+" {
                if number.last != "e", number.last != "E" { flush() }
                number.append(ch)
            } else if ch == "." {
                if number.contains(".") || number.contains("e") || number.contains("E") { flush() }
                number.append(ch)
            } else if ch.isNumber || ch == "e" || ch == "E" {
                number.append(ch)
            } else {
                flush()
            }
        }
        flush()
        return tokens
    }

    /// An SVG arc as cubic segments (the endpoint to center conversion of the SVG spec).
    private static func arc(_ path: inout Path, from p1: CGPoint, to p2: CGPoint, rx: CGFloat, ry: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        guard p1 != p2 else { return }
        guard rx != 0, ry != 0 else {
            path.addLine(to: p2)
            return
        }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p1.x - p2.x) / 2, dy = (p1.y - p2.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy
        var rx = abs(rx), ry = abs(ry)
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= sqrt(lambda)
            ry *= sqrt(lambda)
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coefficient = (large != sweep ? 1 : -1) * sqrt(max(0, numerator / denominator))
        let cx1 = coefficient * rx * y1 / ry
        let cy1 = coefficient * -ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p1.x + p2.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p1.y + p2.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        func at(_ theta: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(theta) * cosPhi - ry * sin(theta) * sinPhi, y: cy + rx * cos(theta) * sinPhi + ry * sin(theta) * cosPhi)
        }
        func derivative(_ theta: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(theta) * cosPhi - ry * cos(theta) * sinPhi, y: -rx * sin(theta) * sinPhi + ry * cos(theta) * cosPhi)
        }
        var theta = theta1
        for _ in 0..<segments {
            let p = at(theta), q = at(theta + step)
            let d1 = derivative(theta), d2 = derivative(theta + step)
            path.addCurve(to: q, control1: CGPoint(x: p.x + t * d1.x, y: p.y + t * d1.y), control2: CGPoint(x: q.x - t * d2.x, y: q.y - t * d2.y))
            theta += step
        }
    }
}
