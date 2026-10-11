// Squirrel.Mac's installer check, as a command: validate an update bundle the
// way ShipIt will before it swaps it in. ShipIt takes the designated
// requirement of the app already installed and runs
// SecStaticCodeCheckValidityWithErrors on its copy of the update with
// kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate
// (Squirrel/SQRLCodeSignature.m). `codesign --verify --deep --strict` is close
// but not the same call. release-publish.sh compiles this with swiftc and runs
// it on the extracted zip against the dmg's app before anything is uploaded.
//
//   swiftc -O -o sqrlcheck scripts/sqrlcheck.swift
//   sqrlcheck <installedApp> <updateApp>      # exit 0 when ShipIt would accept it
import Foundation
import Security

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: sqrlcheck <installedApp> <updateApp>\n".data(using: .utf8)!)
    exit(2)
}
let installed = args[1], update = args[2]

func staticCode(_ path: String) -> SecStaticCode {
    var code: SecStaticCode?
    let status = SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code)
    guard status == errSecSuccess, let code else {
        FileHandle.standardError.write("cannot read code at \(path): \(status)\n".data(using: .utf8)!)
        exit(2)
    }
    return code
}

var requirement: SecRequirement?
let drStatus = SecCodeCopyDesignatedRequirement(staticCode(installed), [], &requirement)
guard drStatus == errSecSuccess, let requirement else {
    FileHandle.standardError.write("no designated requirement on \(installed): \(drStatus)\n".data(using: .utf8)!)
    exit(2)
}
var drText: CFString?
SecRequirementCopyString(requirement, [], &drText)
print("designated requirement of \(installed):\n  \((drText as String?) ?? "?")")

let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
var error: Unmanaged<CFError>?
let status = SecStaticCodeCheckValidityWithErrors(staticCode(update), flags, requirement, &error)
if status == errSecSuccess {
    print("OK: \(update) passes Squirrel's validation against that requirement")
    exit(0)
}
print("FAIL (\(status)): \(update) would be rejected by ShipIt")
if let error = error?.takeRetainedValue() {
    print("  \(error)")
}
exit(1)
