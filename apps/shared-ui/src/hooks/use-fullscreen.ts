import { capabilities } from "@/lib/backend";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// iOS windows have no title bar or traffic lights, so they count as full screen.
export function useIsFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(capabilities.fullscreenLayout);

  useEffect(() => {
    if (!capabilities.windowControls) return;
    const appWindow = getCurrentWindow();

    const update = async () => {
      setIsFullscreen(await appWindow.isFullscreen());
    };

    update();

    let unlisten: (() => void) | undefined;

    appWindow.onResized(async () => {
      await update();
    }).then(fn => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return isFullscreen;
}
