import ComputerProtocol

// ApplicationServices and Carbon bring their own `Rect`, `Point` and `WindowRef`; inside
// Input the wire's are meant, and a name declared in this module wins over an imported one.
typealias Rect = ComputerProtocol.Rect
typealias Point = ComputerProtocol.Point
typealias WindowRef = ComputerProtocol.WindowRef
