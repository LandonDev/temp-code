import React, { useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "./lib/native";
import { installEditorKeys } from "./lib/editorKeys";
import App from "./App";
import { initAppearance, syncWindowGlass } from "./lib/appearance";
import { initSounds } from "./lib/sounds";
import { initServerLink } from "./lib/tcserver/link";
import { sessionStore } from "./lib/tcserver/store";
import { workspaceStore } from "./lib/tcserver/workspaces";
import { rulesStore } from "./lib/tcserver/rules";
import { slashCommandStore } from "./lib/tcserver/slashCommands";
import { handleQuitRequested, loadBootWorkspace, persistLiveWorkspace } from "./lib/appLifecycle";
import { consumeInstalledUpdate } from "./lib/updateNotice";
import { bootstrapWorkspace } from "./stores/bootstrap";
import { installSubscriptions } from "./stores/subscriptions";
import { warmRecentTabsAtBoot } from "./lib/sessionPrefetch";
import { updateStore } from "./lib/updateStore";
import { initAppshots } from "./lib/appshots";
import "./index.css";

// Before App mounts its own window listener: the editor claims its chords first.
installEditorKeys();
initAppearance();
initSounds();
initServerLink();
sessionStore.connect();
workspaceStore.connect();
rulesStore.connect();
slashCommandStore.connect();
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

void listen("quit_requested", () => {
  void handleQuitRequested();
});
void listen("persist_requested", () => {
  void persistLiveWorkspace();
});

void loadBootWorkspace().then(
  ({ windowTransfer, resumed, history, historyCwd }) => {
    const installedUpdate = windowTransfer ? null : consumeInstalledUpdate();
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
        <BootGate>
          <App />
        </BootGate>
      </React.StrictMode>,
    );
    warmRecentTabsAtBoot();
  },
);
