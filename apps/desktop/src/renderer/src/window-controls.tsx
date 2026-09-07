import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from "./icons";

const appWindow = getCurrentWindow();

/** Toggles maximize/restore for this renderer's window (the header
    double-click handler in App.tsx uses it too). */
export function toggleWindowMaximize() {
  void appWindow.toggleMaximize();
}

/**
 * Traffic-light window controls that stand in for the native title bar: the
 * app window is undecorated (see core.rs), so minimise, maximise and close
 * are driven here through the Tauri window API. Orange minimises, green
 * maximises/restores, red closes.
 *
 * The green button swaps to a restore glyph while the window is maximised.
 * The state is re-read on every resize, so an external maximise (Win+Up, a
 * taskbar double-click, another window's toggle) is reflected too.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: (() => void) | null = null;
    void appWindow.isMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then((value) => {
          if (!disposed) setMaximized(value);
        });
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenResize = unlisten;
      });
    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, []);

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button className="window-control is-minimize" title="Minimize" aria-label="Minimize window" onClick={() => void appWindow.minimize()}><MinimizeIcon /></button>
      <button className={`window-control is-maximize ${maximized ? "is-restoring" : ""}`} title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore window" : "Maximize window"} onClick={() => toggleWindowMaximize()}>{maximized ? <RestoreIcon /> : <MaximizeIcon />}</button>
      <button className="window-control is-close" title="Close" aria-label="Close window" onClick={() => void appWindow.close()}><CloseIcon /></button>
    </div>
  );
}