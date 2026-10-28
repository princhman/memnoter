// Recolors an image so it sits on the app's background: the image's own
// background becomes transparent, and when its brightness is opposite to the
// theme's, the remaining "ink" has its lightness flipped (hues are kept).

type RGB = [number, number, number];

const luma = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Colours within NEAR of the background are dropped entirely (compression
// noise, slightly tinted panels), and fade in up to FAR.
const NEAR = 0.03;
const FAR = 0.12;

const bucketOf = (data: Uint8ClampedArray, i: number) =>
  ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);

// The background is the colour covering most of the image among those along
// its border; a border colour alone misleads when a strip of another shade
// runs along one edge. Returns null when the border is mostly transparent
// (the image already has no background of its own).
export function detectBackground(data: Uint8ClampedArray, width: number, height: number): RGB | null {
  const border = new Map<number, number>();
  let transparent = 0;
  let total = 0;
  const step = Math.max(1, Math.floor((2 * (width + height)) / 2000));
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    total++;
    if (data[i + 3] < 200) transparent++;
    else border.set(bucketOf(data, i), (border.get(bucketOf(data, i)) ?? 0) + 1);
  };
  for (let x = 0; x < width; x += step) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    sample(0, y);
    sample(width - 1, y);
  }
  if (total === 0 || transparent * 2 > total) return null;
  // Colours along at least a tenth of the opaque border.
  const candidates = new Map<number, { count: number; sum: RGB }>();
  for (const [key, count] of border) {
    if (count * 10 >= total - transparent) candidates.set(key, { count: 0, sum: [0, 0, 0] });
  }
  const stride = Math.max(1, Math.floor((width * height) / 200_000)) * 4;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < 200) continue;
    const candidate = candidates.get(bucketOf(data, i));
    if (!candidate) continue;
    candidate.count++;
    candidate.sum[0] += data[i];
    candidate.sum[1] += data[i + 1];
    candidate.sum[2] += data[i + 2];
  }
  let best: { count: number; sum: RGB } | null = null;
  for (const candidate of candidates.values()) if (!best || candidate.count > best.count) best = candidate;
  if (!best?.count) return null;
  return [best.sum[0] / best.count / 255, best.sum[1] / best.count / 255, best.sum[2] / best.count / 255];
}

// Average brightness of the visible pixels, for images without a background.
function inkLuma(data: Uint8ClampedArray) {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 16) {
    const a = data[i + 3] / 255;
    sum += a * luma([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    weight += a;
  }
  return weight ? sum / weight : 0;
}

// Adapts RGBA pixels in place for a dark or light theme.
export function adaptPixels(data: Uint8ClampedArray, width: number, height: number, dark: boolean) {
  const background = detectBackground(data, width, height);
  // Ink drawn for a light background is dark, and vice versa.
  const invert = background ? luma(background) > 0.5 === dark : inkLuma(data) > 0.5 !== dark;
  const pixel: RGB = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    let alpha = 1;
    pixel[0] = data[i] / 255;
    pixel[1] = data[i + 1] / 255;
    pixel[2] = data[i + 2] / 255;
    if (background) {
      // The least opacity at which some colour over the background gives this
      // pixel, then that colour ("colour to alpha").
      alpha = 0;
      for (let c = 0; c < 3; c++) {
        const p = pixel[c], b = background[c];
        if (p > b) alpha = Math.max(alpha, (p - b) / (1 - b));
        else if (p < b) alpha = Math.max(alpha, (b - p) / b);
      }
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) {
          pixel[c] = Math.min(1, Math.max(0, (pixel[c] - (1 - alpha) * background[c]) / alpha));
        }
      }
      // Near the background colour-to-alpha is unstable: a pixel just lighter
      // than an off-white background would come out as opaque white ink.
      const distance = Math.max(
        Math.abs(data[i] / 255 - background[0]),
        Math.abs(data[i + 1] / 255 - background[1]),
        Math.abs(data[i + 2] / 255 - background[2]),
      );
      const t = Math.min(1, Math.max(0, (distance - NEAR) / (FAR - NEAR)));
      alpha *= t * t * (3 - 2 * t);
    }
    if (invert) {
      // Shifting every channel equally flips HSL lightness but keeps the hue
      // and chroma: dark blue becomes light blue, black becomes white.
      const shift = 1 - Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
      pixel[0] += shift;
      pixel[1] += shift;
      pixel[2] += shift;
    }
    data[i] = Math.round(pixel[0] * 255);
    data[i + 1] = Math.round(pixel[1] * 255);
    data[i + 2] = Math.round(pixel[2] * 255);
    data[i + 3] = Math.round(alpha * data[i + 3]);
  }
}

// Large photos are scaled down: the result is only ever shown at editor width.
const MAX_SIDE = 2560;

// Runs where it is called: in the worker, or on the main thread as a fallback.
export async function adaptImageHere(source: Blob, dark: boolean): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not prepare the image");
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    adaptPixels(pixels.data, width, height, dark);
    context.putImageData(pixels, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

// Recoloring a large image takes tens of milliseconds, so it runs off the main
// thread. The single worker also takes images one at a time.
let worker: Worker | null | undefined;
let nextJob = 0;
const jobs = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();

function adaptWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./image-adapt.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.blob) job?.resolve(data.blob);
      else job?.reject(new Error(data.error ?? "Could not adapt the image"));
    };
    // The worker failed to start: fail what it holds, adapt here from now on.
    worker.onerror = () => {
      worker = null;
      for (const job of jobs.values()) job.reject(new Error("Could not start the image worker"));
      jobs.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

function adaptImage(source: Blob, dark: boolean): Promise<Blob> {
  const target = adaptWorker();
  if (!target) return adaptImageHere(source, dark);
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    target.postMessage({ id, source, dark });
  });
}

// Adapted copies by image and theme. Sections mount and unmount as they scroll
// into view, so without this every remount would recolor (and blink) again.
const cache = new Map<string, { url?: string; pending: Promise<string> }>();
const CACHE_SIZE = 48;

const cacheKey = (image: string, dark: boolean) => `${dark ? "dark" : "light"}:${image}`;

export function cachedAdaptedUrl(image: string, dark: boolean) {
  return cache.get(cacheKey(image, dark))?.url;
}

export function adaptedUrl(image: string, dark: boolean, load: () => Promise<Blob>) {
  const key = cacheKey(image, dark);
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last, so eviction drops the stalest.
    cache.delete(key);
    cache.set(key, hit);
    return hit.pending;
  }
  const entry: { url?: string; pending: Promise<string> } = {
    pending: load()
      .then((blob) => adaptImage(blob, dark))
      .then((blob) => (entry.url = URL.createObjectURL(blob))),
  };
  entry.pending.catch(() => cache.delete(key));
  cache.set(key, entry);
  // Entries still being adapted stay: their URL does not exist yet to revoke,
  // and an image is waiting for it. Once done, a later eviction can drop them.
  for (const [oldKey, old] of cache) {
    if (cache.size <= CACHE_SIZE) break;
    if (!old.url) continue;
    cache.delete(oldKey);
    URL.revokeObjectURL(old.url);
  }
  return entry.pending;
}
