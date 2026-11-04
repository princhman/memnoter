import { adaptImageHere } from "./image-adapt";

// One image at a time: each holds a full-size bitmap and pixel buffer.
let queue = Promise.resolve();

self.onmessage = ({ data }: MessageEvent<{ id: number; source: Blob; dark: boolean }>) => {
  queue = queue.then(async () => {
    try {
      const blob = await adaptImageHere(data.source, data.dark);
      self.postMessage({ id: data.id, blob });
    } catch {
      // The page retries it itself.
      self.postMessage({ id: data.id });
    }
  });
};
