import React, { Profiler, useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
import { getVersion, listen } from "./lib/native";
import { installEditorKeys } from "./lib/editorKeys";
import App from "./App";
import { initAppearance, syncWindowGlass } from "./lib/appearance";
import { initSounds } from "./lib/sounds";
import { initServerLink } from "./lib/tcserver/link";
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
import { connectProjectPathMap } from "./lib/projectMerge";
import { initAppshots } from "./lib/appshots";
import { recordCommit } from "./lib/renderProfile";
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
initServerLink();
// The project pairing's path map, from this machine's server once it opens.
connectProjectPathMap();
updateStore.start();
initAppshots();

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash || splash.dataset.dismissed === "1") return;
  splash.dataset.dismissed = "1";
  const fade = () => {
    // The window was created with vibrancy; only now may the page go
    // transparent over it (index.css `html.is-mac.glass.ready`).
    document.documentElement.classList.add("ready");
    // Launch-timing probe (scripts/e2e-launch-timing.ts): the UI is on screen.
    performance.mark("tc:ready");
    syncWindowGlass();
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
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Root />
      </React.StrictMode>,
    );
    warmRecentTabsAtBoot();
  },
);
