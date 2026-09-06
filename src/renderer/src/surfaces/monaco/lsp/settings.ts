import type { Engine, LangKind } from "./types";

/** What `lsp.ensure` hands back beyond the socket path. */
export interface EnsureExtras {
  tsdkPath?: string;
  javaRuntimes?: { name: string; path: string }[];
  eulaHash?: string;
  defaultSdk?: string;
  buildTool?: string;
}

/** initializationOptions per server kind, verbatim from temp-code. */
export function settingsFor(
  kind: LangKind,
  extras: EnsureExtras,
  engine: Engine = "standard",
  rootUri?: string,
): Record<string, unknown> {
  if (engine === "idea") {
    // EULA handshake, a JDK, and a forced importer for the root: repos with a
    // checked-in .idea otherwise skip import silently.
    return {
      ...(extras.eulaHash ? { eulaHash: extras.eulaHash } : {}),
      ...(extras.defaultSdk ? { defaultSdk: extras.defaultSdk } : {}),
      ...(extras.buildTool && rootUri ? { buildTools: { [rootUri]: extras.buildTool } } : {}),
    };
  }
  if (kind === "web") {
    return {
      settings: {
        typescript: {
          ...(extras.tsdkPath ? { tsdk: extras.tsdkPath } : {}),
          suggest: { completeFunctionCalls: true },
          inlayHints: { parameterNames: { enabled: "literals" } },
        },
        javascript: { inlayHints: { parameterNames: { enabled: "literals" } } },
        vtsls: { autoUseWorkspaceTsdk: true },
      },
      ...(extras.tsdkPath ? { typescript: { tsdk: extras.tsdkPath } } : {}),
    };
  }
  return {
    settings: {
      java: {
        configuration: {
          updateBuildConfiguration: "automatic",
          runtimes: (extras.javaRuntimes ?? []).map((r, i) => ({
            name: r.name,
            path: r.path,
            default: i === 0,
          })),
        },
        autobuild: { enabled: true },
        maxConcurrentBuilds: 1,
        errors: { incompleteClasspath: { severity: "warning" } },
        inlayHints: { parameterNames: { enabled: "literals" } },
        format: { enabled: true },
        signatureHelp: { enabled: true },
        completion: {
          enabled: true,
          // jdt.ls caps at 50 items in rough alphabetical order; 0 lifts the
          // cap so the relevance ranking (sortText) decides.
          maxResults: 0,
          postfix: { enabled: true },
          chain: { enabled: true },
          guessMethodArguments: "off",
          matchCase: "off",
          favoriteStaticMembers: [
            "org.junit.Assert.*",
            "org.junit.Assume.*",
            "org.junit.jupiter.api.Assertions.*",
            "org.junit.jupiter.api.Assumptions.*",
            "org.mockito.Mockito.*",
            "org.mockito.ArgumentMatchers.*",
            "java.util.Objects.requireNonNull",
            "java.util.Objects.requireNonNullElse",
          ],
        },
        maven: { downloadSources: false },
        references: { includeDecompiledSources: true },
      },
    },
    extendedClientCapabilities: { classFileContentsSupport: false },
  };
}
