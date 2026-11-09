import { toast } from "sonner";

// The result of an import, as a Sonner toast. Anything the user may want to
// read (warnings, skipped files, an error) stays until dismissed; a clean
// import goes away by itself.
export function importToast(kind: "success" | "error", text: string, details: string[] = [], label = "details") {
  const description = details.length
    ? <details className="max-h-52 overflow-auto"><summary>{details.length} {label}</summary><ul className="mt-2 space-y-1">{details.map((line, index) => <li key={index}>{line}</li>)}</ul></details>
    : undefined;
  const show = kind === "error" ? toast.error : details.length ? toast.warning : toast.success;
  show(text, { description, duration: kind === "error" || details.length ? Infinity : 8000, closeButton: kind === "error" || details.length > 0 });
}
