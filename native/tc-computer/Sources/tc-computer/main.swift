// tc-computer: TempCode's computer-use service on the Mac (docs/computer-protocol.md, native/tc-computer/README.md).
import ComputerService

MainActor.assumeIsolated {
    CommandLineTool.main(Array(CommandLine.arguments.dropFirst()))
}
