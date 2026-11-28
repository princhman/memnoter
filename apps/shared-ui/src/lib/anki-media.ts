import { invoke } from "@tauri-apps/api/core";

type Image = { id: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> };

export async function readAnkiMedia(sourceId: string, names: string[]): Promise<Uint8Array<ArrayBuffer>[]> {
  let response: ArrayBuffer | number[];
  try {
    response = await invoke<ArrayBuffer | number[]>("read_anki_media", { sourceId, names });
  } catch (error) {
    if (names.length > 1 && String(error).includes("Anki image batch exceeds 128 MiB")) {
      const middle = Math.floor(names.length / 2);
      const first = await readAnkiMedia(sourceId, names.slice(0, middle));
      return first.concat(await readAnkiMedia(sourceId, names.slice(middle)));
    }
    throw error;
  }
  const buffer = Array.isArray(response) ? new Uint8Array(response).buffer : response;
  const view = new DataView(buffer);
  let offset = 0;
  const images = names.map(() => {
    const length = view.getUint32(offset, true);
    offset += 4;
    const bytes = new Uint8Array(buffer, offset, length);
    offset += length;
    return bytes;
  });
  if (offset !== view.byteLength) throw new Error("Unexpected bytes in Anki media batch.");
  return images;
}

export function saveAnkiModule(name: string, note: Uint8Array, images: Image[]): Promise<string> {
  const header = new TextEncoder().encode(JSON.stringify({
    name,
    noteLength: note.length,
    images: images.map(({ id, mimeType, bytes }) => ({ id, mimeType, length: bytes.length })),
  }));
  const body = new Uint8Array(4 + header.length + note.length + images.reduce((sum, image) => sum + image.bytes.length, 0));
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.set(note, 4 + header.length);
  let offset = 4 + header.length + note.length;
  for (const image of images) {
    body.set(image.bytes, offset);
    offset += image.bytes.length;
  }
  return invoke<string>("import_anki_module", body);
}
