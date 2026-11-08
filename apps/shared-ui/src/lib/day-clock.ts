const DUE_REFRESH_MS = 60_000;

export function startOfDay(now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// All cutoff consumers share one clock, only while the setting is enabled.
const dayListeners = new Set<() => void>();
let stopDayClock: (() => void) | undefined;

export function subscribeDay(listener: () => void) {
  dayListeners.add(listener);
  if (!stopDayClock) {
    const refresh = () => {
      for (const notify of dayListeners) notify();
    };
    let midnight: number;
    const scheduleMidnight = () => {
      midnight = window.setTimeout(() => {
        refresh();
        scheduleMidnight();
      }, endOfDay(Date.now()) - Date.now() + 50);
    };
    const timer = window.setInterval(refresh, DUE_REFRESH_MS);
    scheduleMidnight();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    stopDayClock = () => {
      window.clearInterval(timer);
      window.clearTimeout(midnight);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }
  return () => {
    dayListeners.delete(listener);
    if (dayListeners.size === 0) {
      stopDayClock?.();
      stopDayClock = undefined;
    }
  };
}

// The next local midnight.
export function endOfDay(now: number) {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return end.getTime();
}
