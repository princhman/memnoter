import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useIsFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
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
