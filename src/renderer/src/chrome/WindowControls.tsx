import { getCurrentWindow } from "../lib/native";
import { Copy, Minus, Square, X } from "./icons";
import { useEffect, useState } from "react";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { TooltipProvider } from "../components/ui/tooltip";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const win = getCurrentWindow();
    void win.isMaximized().then((max) => {
      if (mounted) setIsMaximized(max);
    }).catch(() => {});

    void win.onResized(async () => {
      try {
        const max = await win.isMaximized();
        if (mounted) setIsMaximized(max);
      } catch {}
    }).then((unlistenFn) => {
      if (mounted) {
        unlisten = unlistenFn;
      } else {
        unlistenFn();
      }
    }).catch(() => {});

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => {
    try {
      void getCurrentWindow().minimize();
    } catch {}
  };

  const handleToggleMaximize = () => {
    try {
      void getCurrentWindow().toggleMaximize();
    } catch {}
  };

  const handleClose = () => {
    try {
      void getCurrentWindow().close();
    } catch {}
  };

  return (
    <TooltipProvider>
      <div className="flex h-full shrink-0 items-stretch border-l border-border" data-tauri-drag-region="false">
        <Tip label="Minimize" side="bottom">
          <Button
            variant="ghost"
            aria-label="Minimize window"
            data-tauri-drag-region="false"
            onClick={handleMinimize}
            className="h-full w-10 rounded-none text-muted-foreground"
          >
            <Minus className="size-3.5" strokeWidth={1.75} />
          </Button>
        </Tip>
        <Tip label={isMaximized ? "Restore" : "Maximize"} side="bottom">
          <Button
            variant="ghost"
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            data-tauri-drag-region="false"
            onClick={handleToggleMaximize}
            className="h-full w-10 rounded-none text-muted-foreground"
          >
            {isMaximized ? <Copy className="size-3" strokeWidth={1.75} /> : <Square className="size-3" strokeWidth={1.75} />}
          </Button>
        </Tip>
        <Tip label="Close" side="bottom">
          <Button
            variant="ghost"
            aria-label="Close window"
            data-tauri-drag-region="false"
            onClick={handleClose}
            className="h-full w-10 rounded-none text-muted-foreground hover:bg-destructive hover:text-primary-foreground"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </Button>
        </Tip>
      </div>
    </TooltipProvider>
  );
}
