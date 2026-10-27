import React, { Profiler, Suspense, lazy, useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
import { getVersion, listen } from "./lib/native";
import { installEditorKeys } from "./lib/editorKeys";
import App from "./App";
import { ConfirmHost } from "./chrome/ConfirmDialog";
/* The toast stack rides its own chunk: sonner is not part of the first paint. */
const Toaster = lazy(() => import("./components/ui/toaster").then((m) => ({ default: m.Toaster })));
import { initAppearance } from "./lib/appearance";
import { initSounds } from "./lib/sounds";
import { initServerLink } from "./lib/tcserver/link";
import { hydrateFromLaunchMirror, installLaunchMirror } from "./lib/tcserver/launchMirror";
import { registry } from "./lib/connection";
import { sessionStore } from "./lib/tcserver/store";
import { workspaceStore } from "./lib/tcserver/workspaces";
import { inboxStore } from "./lib/inboxStore";
import { rulesStore } from "./lib/tcserver/rules";
import { slashCommandStore } from "./lib/tcserver/slashCommands";
import { handleQuitRequested, loadBootWorkspace, persistLiveWorkspace } from "./lib/appLifecycle";
import { consumeInstalledUpdate } from "./lib/updateNotice";
import { bootstrapWorkspace } from "./stores/bootstrap";
import { installSubscriptions } from "./stores/subscriptions";
import { accountsStore } from "./stores/accounts";
import { warmRecentTabsAtBoot } from "./lib/sessionPrefetch";
import { updateStore } from "./lib/updateStore";
import { initAppshots } from "./lib/appshots";
import { recordCommit } from "./lib/renderProfile";
import { reportRendererError } from "./lib/rendererErrors";
import { RootBoundary } from "./chrome/RootBoundary";
import "./index.css";

// Before App mounts its own window listener: the editor claims its chords first.
installEditorKeys();
initAppearance();
initSounds();
// The stores follow the registry: one link per environment, attached as
// each is added; then boot registers environment zero.
sessionStore.connect(registry);
workspaceStore.connect(registry);
inboxStore.connect(registry);
rulesStore.connect(registry);
slashCommandStore.connect(registry);
accountsStore.connect(registry);
// Before environment zero and before the first render: every host's rows as
// the launch mirror last saw them, so the rail is whole on its first frame
// and a host that answers late (or not at all) still has its section.
hydrateFromLaunchMirror();
initServerLink();
installLaunchMirror();
updateStore.start();
initAppshots();

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash || splash.dataset.dismissed === "1") return;
  splash.dataset.dismissed = "1";
  const fade = () => {
    document.documentElement.classList.add("ready");
    // Launch-timing probe (scripts/e2e-launch-timing.ts): the UI is on screen.
    performance.mark("tc:ready");
    // The rail's first full paint (scripts/e2e-launch-mirror.ts): every
    // host's rows are on screen, listed or painted from the launch mirror.
    void sessionStore.whenPainted().then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("tc:rail-complete")));
    });
    splash.classList.add("boot-splash-out");
    window.setTimeout(() => splash.remove(), 180);
  };
  // useLayoutEffect runs before paint. Two frames later the app is on
  // screen, so the fade reveals UI instead of the desktop blur.
  requestAnimationFrame(() => {
    requestAnimationFrame(fade);
  });
}

function BootGate({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    dismissBootSplash();
  }, []);
  return children;
}

// Dev and measurement builds (TEMP_CODE_PROFILE=1, where react-dom/client is
// the profiling reconciler) count every root commit for `__app.profile`; a
// release build renders the bare tree.
const PROFILED = import.meta.env.DEV || import.meta.env.TEMP_CODE_PROFILE === "1";

function Root() {
  const tree = (
    <BootGate>
      <App />
      <ConfirmHost />
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </BootGate>
  );
  return PROFILED ? (
    <Profiler id="app" onRender={recordCommit}>
      {tree}
    </Profiler>
  ) : (
    tree
  );
}

void listen("quit_requested", () => {
  void handleQuitRequested();
});
void listen("persist_requested", () => {
  void persistLiveWorkspace();
});

// The running version decides whether the "Updated to X" marker is true;
// a failed install relaunches the old build with the marker still set.
const runningVersion = getVersion().catch(() => "");

void Promise.all([loadBootWorkspace(), runningVersion]).then(
  ([{ windowTransfer, resumed, history, historyCwd }, version]) => {
    const installedUpdate = windowTransfer ? null : consumeInstalledUpdate(undefined, version);
    bootstrapWorkspace({
      windowTransfer,
      resumed,
      history,
      historyCwd,
      installedUpdate,
    });
    // The stores are full; the effects that follow them start before the first render.
    installSubscriptions();
    // Every render error reaches stalls.log as one line; one no surface's
    // boundary held leaves "Something broke" and Reload window, never a
    // blank window.
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
      onUncaughtError: (error) => reportRendererError("uncaught", error),
      onCaughtError: (error) => reportRendererError("caught", error),
    }).render(
      <React.StrictMode>
        <RootBoundary>
          <Root />
        </RootBoundary>
      </React.StrictMode>,
    );
    warmRecentTabsAtBoot();
  },
);
