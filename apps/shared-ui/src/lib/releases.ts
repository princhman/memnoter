const DAY = 86_400_000;
const KEY = "memnoter-release-check";
// GitHub's latest endpoint returns stable releases. Reject unexpected tags.
export function newerRelease(current: string, latest: string): boolean {
  const parse = (value: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.exec(value)?.slice(1, 4).map(Number);
  const a = parse(current), b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}
export async function latestRelease(current: string): Promise<string | null> {
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (cached && Date.now() - cached.checked < DAY) return newerRelease(current, cached.tag ?? "") ? cached.tag : null;
    // Record attempts as well as successes, so offline launches stay quiet.
    localStorage.setItem(KEY, JSON.stringify({ checked: Date.now() }));
    const response = await fetch("https://api.github.com/repos/princhman/memnoter/releases/latest", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const release = await response.json();
    if (release.draft || release.prerelease || typeof release.tag_name !== "string") return null;
    localStorage.setItem(KEY, JSON.stringify({ checked: Date.now(), tag: release.tag_name }));
    return newerRelease(current, release.tag_name) ? release.tag_name : null;
  } catch { return null; }
}
