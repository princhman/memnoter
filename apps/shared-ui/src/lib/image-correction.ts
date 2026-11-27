import { makeImageCanvas } from "./image-canvas";

const MAX_SIDE = 2560;

function luminance(red: number, green: number, blue: number) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function percentile(histogram: Uint32Array, rank: number) {
  let count = 0;
  for (let light = 0; light < histogram.length; light++) {
    count += histogram[light];
    if (count >= rank) return light;
  }
  return 255;
}

// Estimate black and white points from opaque pixels, ignoring isolated extremes.
export function correctImagePixels(data: Uint8ClampedArray): boolean {
  const histogram = new Uint32Array(256);
  const stride = Math.max(1, Math.ceil(data.length / 4 / 100_000)) * 4;
  let samples = 0;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] !== 255) continue;
    histogram[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
    samples++;
  }
  if (histogram.filter(count => count > 0).length < 12) return false;

  const black = percentile(histogram, samples * 0.01);
  const white = percentile(histogram, samples * 0.99);
  // Leave full-range images alone, including screenshots with strong colours.
  // A narrow range gives too little information to estimate both endpoints.
  if (white - black >= 218 || white - black < 32) return false;

  const highlight = Math.max(96, percentile(histogram, samples * 0.8));
  const neutral = [0, 0, 0];
  let highlights = 0;
  for (let i = 0; i < data.length; i += stride) {
    const red = data[i], green = data[i + 1], blue = data[i + 2];
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (data[i + 3] !== 255 || chroma > 55 || luminance(red, green, blue) < highlight - 0.5) continue;
    neutral[0] += red;
    neutral[1] += green;
    neutral[2] += blue;
    highlights++;
  }
  // Without a plausible paper/whiteboard highlight, leave the palette alone.
  if (highlights < samples * 0.05) return false;

  const neutralLight = luminance(neutral[0], neutral[1], neutral[2]) / highlights;
  const blackTarget = Math.min(black, 12);
  const scale = Math.min(2.4, (247 - blackTarget) / (white - black));
  const lift = Math.min(18, 247 - blackTarget - (white - black) * scale);
  const offsets = neutral.map(total => Math.max(-25, Math.min(25, neutralLight - total / highlights)));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const light = luminance(data[i], data[i + 1], data[i + 2]);
    // Keep the balance adjustment small in shadows and strongest on the paper.
    const balance = Math.min(1, light / neutralLight);
    const shift = Math.max(8, Math.min(247, (light - black) * scale + blackTarget + lift)) - light;
    for (let channel = 0; channel < 3; channel++) {
      data[i + channel] += shift + offsets[channel] * balance;
    }
  }
  return true;
}

async function isStaticRaster(file: File) {
  if (file.type === "image/jpeg") return true;
  if (file.type === "image/webp") {
    const header = new Uint8Array(await file.slice(0, 21).arrayBuffer());
    // VP8X stores animation in bit 1 of the first feature byte.
    return header.length === 21 && (header[15] !== 0x58 || (header[20] & 2) === 0);
  }
  if (file.type !== "image/png") return false;

  // APNG declares animation before its first image data chunk. Leave files
  // with unusually large headers alone if we cannot establish that safely.
  const header = new DataView(await file.slice(0, 64 * 1024).arrayBuffer());
  for (let offset = 8; offset + 8 <= header.byteLength;) {
    const kind = header.getUint32(offset + 4);
    if (kind === 0x6163544c) return false; // acTL
    if (kind === 0x49444154) return true; // IDAT
    offset += 12 + header.getUint32(offset);
  }
  return false;
}

export async function correctImageFile(file: File): Promise<File> {
  try {
    if (!await isStaticRaster(file)) return file;
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const { context, encode } = makeImageCanvas(width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      if (!correctImagePixels(pixels.data)) return file;
      context.putImageData(pixels, 0, 0);
      const corrected = await encode(file.type, 0.88);
      if (corrected.type !== file.type || corrected.size > file.size * 1.5 + 256 * 1024) return file;
      return new File([corrected], file.name, { type: file.type, lastModified: file.lastModified });
    } finally {
      bitmap.close();
    }
  } catch {
    // If decoding or encoding fails, the original can still be saved.
    return file;
  }
}
