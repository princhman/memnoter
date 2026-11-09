import { PDF_CHUNK_BYTES, PDF_CHUNK_COMMAND } from "../editor-host/protocol";
import { call } from "./backend";
import { fromBase64, SYNC_CONTRACT } from "./sync/protocol";

// WK's custom asset scheme supports image elements but cannot reliably serve
// PDF.js XHR. Bound each local bridge reply without expanding bytes into JSON
// numbers or weakening the native resource handler's file boundary.
export async function readNativePdf(documentId: string, signal: AbortSignal): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  let offset = 0;
  do {
    signal.throwIfAborted();
    const result = await call<unknown>(PDF_CHUNK_COMMAND, { documentId, offset, length: PDF_CHUNK_BYTES });
    signal.throwIfAborted();
    if (typeof result !== "object" || result === null || !("total" in result) ||
      typeof result.total !== "number" || !Number.isSafeInteger(result.total) || result.total <= 0 || result.total > SYNC_CONTRACT.MAX_FILE_BYTES ||
      !("offset" in result) || result.offset !== offset || !("data" in result) || typeof result.data !== "string" ||
      result.data.length > 4 * Math.ceil(PDF_CHUNK_BYTES / 3) || (bytes && bytes.length !== result.total)) {
      throw new Error("The native PDF response is invalid. Reopen the PDF to try again.");
    }
    const chunk = fromBase64(result.data);
    if (chunk.length !== Math.min(PDF_CHUNK_BYTES, result.total - offset)) throw new Error("The PDF read was incomplete. Reopen the PDF to try again.");
    bytes ??= new Uint8Array(result.total);
    bytes.set(chunk, offset);
    offset += chunk.length;
  } while (offset < bytes.length);
  return bytes;
}
