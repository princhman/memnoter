import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fileUrl, isNativeHost } from "./backend";
import { documentPath } from "./documents";
import { readNativePdf } from "./native-pdf";

GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(id: string, signal: AbortSignal) {
  const source = isNativeHost() ? { data: await readNativePdf(id, signal) } : { url: fileUrl(await documentPath({ id })) };
  signal.throwIfAborted();
  const asset = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, document.baseURI).href;
  return getDocument({ ...source, cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
}
