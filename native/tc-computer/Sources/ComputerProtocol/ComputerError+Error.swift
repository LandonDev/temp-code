import Foundation

/// The generated wire error is what every part throws as it is (input A11). It lives beside the
/// wire types, not in ComputerCore, so the Foundation-only ComputerServiceKit can catch it too.
extension ComputerError: Error {}
