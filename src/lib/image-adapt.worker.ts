import { adaptImageHere } from "./image-adapt";

self.onmessage = async ({ data }: MessageEvent<{ id: number; source: Blob; dark: boolean }>) => {
  try {
    const blob = await adaptImageHere(data.source, data.dark);
    self.postMessage({ id: data.id, blob });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
