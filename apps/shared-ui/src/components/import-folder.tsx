import { IMPORT_FOLDER_EVENT } from "@/lib/app-events";
import { Toast } from "./ui/toast";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { call } from "@/lib/backend";
import { defaultImportOptions, importNoteOrder, prepareFolderImport, type ImportFolder, type ImportOptions } from "@/lib/folder-import";
import { importFolder } from "@/lib/import-module";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ImportNoteList, importCheckboxClass } from "./import-note-list";

type Plan = Awaited<ReturnType<typeof prepareFolderImport>>;
export function ImportFolderDialog({ onImported }: { onImported: (id: string) => Promise<void> }) {
  const [folder, setFolder] = useState<ImportFolder>();
  const [name, setName] = useState("");
  const [options, setOptions] = useState<ImportOptions>(defaultImportOptions);
  const [plan, setPlan] = useState<Plan>();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<{ text: string; details: string[] }>();
  // The picked image folder, and how many references resolved before it was added.
  const [imageFolder, setImageFolder] = useState<{ name: string; images: number; foundBefore: number }>();
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    let picking = false;
    const pick = async () => {
      if (picking) return;
      picking = true;
      try {
        const selected = await call<ImportFolder | null>("pick_import_folder");
        if (!selected) return;
        setName(selected.name); setOptions({ ...defaultImportOptions, order: importNoteOrder(selected), excluded: [] });
        setStep(0); setError(""); setPlan(undefined); setImageFolder(undefined); setFolder(selected);
      } catch (e) { setSummary({ text: "Could not scan folder", details: [String(e)] }); }
      finally { picking = false; }
    };
    window.addEventListener(IMPORT_FOLDER_EVENT, pick);
    return () => window.removeEventListener(IMPORT_FOLDER_EVENT, pick);
  }, []);
  useEffect(() => {
    if (!folder) return;
    let active = true;
    setPlan(undefined);
    void prepareFolderImport(folder, () => {}, options).then(p => { if (active) { setPlan(p); setError(""); } }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [folder, options]);
  const addImages = async () => {
    setScanning(true); setError("");
    try {
      const extra = await call<ImportFolder | null>("pick_import_image_folder");
      if (!extra) return;
      const foundBefore = imageFolder?.foundBefore ?? plan?.resolvedReferences ?? 0;
      setImageFolder({ name: extra.name, images: extra.entries.length, foundBefore });
      setOptions(previous => ({ ...previous, extraImages: extra.entries, extraImageFolder: extra.name }));
    } catch (e) { setError(String(e)); }
    finally { setScanning(false); }
  };
  const removeImageFolder = () => {
    setImageFolder(undefined);
    setOptions(previous => ({ ...previous, extraImages: undefined, extraImageFolder: undefined }));
  };
  const save = async () => {
    if (!folder || !plan || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await importFolder({ ...folder, originalName: folder.name, name: name.trim() }, setProgress, options);
      setFolder(undefined);
      setSummary({ text: `Imported ${result.notes.length} ${result.notes.length === 1 ? "note" : "notes"} and ${result.images.length} ${result.images.length === 1 ? "image" : "images"} into ${result.name}.`, details: [...(result.indexingWarning ? [result.indexingWarning] : []), ...result.unresolved.map(s => `Unresolved image: ${s}`), ...result.skipped.map(s => `Skipped: ${s}`)] });
      await onImported(result.moduleId);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setProgress(""); }
  };
  // Scanning a picked image folder changes the plan; wait for it before moving on.
  const locked = busy || scanning;
  const titles = ["Module name", "Choose and order notes", "Find images", "Formatting"];
  const found = plan?.resolvedReferences ?? 0;
  const missing = plan?.imageIssues.length ?? 0;
  const total = found + missing;
  const imageStatus = !plan ? "Checking images…" : !total ? "These notes don't reference any images."
    : !missing ? `${total === 1 ? "1 image" : `All ${total} images`} found.`
    : `${found} of ${total} ${total === 1 ? "image" : "images"} found. ${missing === 1 ? "1 is" : `${missing} are`} missing.`;
  return <>
    <Dialog open={!!folder} onOpenChange={open => { if (!open && !locked) setFolder(undefined); }}>
      <DialogContent className="sm:max-w-xl h-[min(36rem,85dvh)] grid-rows-[auto_minmax(0,1fr)_auto]" showCloseButton={!locked}>
        <DialogHeader><DialogTitle>Import folder</DialogTitle><p className="text-muted-foreground">Step {step + 1} of 4, {titles[step]}</p></DialogHeader>
        <div className={`min-h-0 ${step === 1 ? "flex flex-col gap-3 overflow-hidden" : "overflow-auto space-y-3"}`}>
          {step === 0 && <label className="grid gap-2">Module name<Input autoFocus value={name} onChange={e => setName(e.target.value)} disabled={busy} /><span className="text-muted-foreground">{folder?.name}. Nothing is saved until you press Import.</span></label>}
          {step === 1 && <><ImportNoteList order={options.order ?? []} excluded={options.excluded ?? []} disabled={busy}
            onReorder={order => setOptions(previous => ({ ...previous, order }))}
            onInclude={(path, included) => setOptions(previous => ({ ...previous, excluded: included ? previous.excluded?.filter(p => p !== path) : [...previous.excluded ?? [], path] }))} />
            <details className="shrink-0 max-h-20 overflow-auto"><summary>{plan?.skipped.length ?? 0} {plan?.skipped.length === 1 ? "file" : "files"} can't be imported</summary><ul>{plan?.skipped.map(p => <li key={p}>{p}</li>)}</ul></details></>}
          {step === 2 && <>
            <p role="status">{imageStatus}</p>
            {[...new Set(plan?.imageIssues.map(i => i.note))].map(note => <section key={note}><h3 className="font-medium">{note.replace(/\.md$/i, "")}</h3><ul className="list-disc pl-5">{plan?.imageIssues.filter(i => i.note === note).map((issue, i) => <li key={i}>{issue.ambiguous ? `Several files are named ${issue.target}: couldn't tell which one to use.` : `${issue.target}: not found.`}</li>)}</ul></section>)}
            {imageFolder && <div role="status" className="rounded-md bg-muted px-3 py-2">
              {!plan ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Looking for images in {imageFolder.name}…</span>
                : <>Using {imageFolder.name} ({imageFolder.images === 1 ? "1 image" : `${imageFolder.images} images`}): {imageFolder.images === 0 ? "it has no images." : found > imageFolder.foundBefore ? `found ${found - imageFolder.foundBefore} missing ${found - imageFolder.foundBefore === 1 ? "image" : "images"}.` : "none of the missing images are there."}{" "}
                  <button type="button" className="text-link underline-offset-2 hover:underline" disabled={busy || scanning} onClick={removeImageFolder}>Don't use this folder</button></>}
            </div>}
            {plan && total > 0 && <><Button variant={missing ? "default" : "ghost"} size="sm" className="justify-self-start" disabled={busy || scanning} onClick={() => void addImages()}>
              {scanning ? <><Loader2 className="size-4 animate-spin" />Scanning folder…</> : imageFolder ? "Choose a different folder…" : "Look in another folder…"}
            </Button>{missing > 0 && !imageFolder && <p className="text-muted-foreground">Pick the folder where these images are stored, for example your vault's attachments folder.</p>}</>}
          </>}
          {step === 3 && <>{([ ["removeNoteLinks", "Remove links to other notes"], ["removeUnsupportedEmbeds", "Remove embedded files that can't be shown (PDFs, etc.)"], ["keepFrontMatter", "Keep note properties (front matter) as a code block"] ] as const).map(([key, label]) => <label key={key} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 leading-5"><input className={importCheckboxClass} type="checkbox" disabled={busy} checked={options[key]} onChange={e => setOptions({ ...options, [key]: e.target.checked })} /><span>{label}</span></label>)}<p className="text-muted-foreground">{plan?.notes.length ?? 0} {plan?.notes.length === 1 ? "note will" : "notes will"} be imported. Missing images will show as placeholders.</p></>}
        </div>
        <div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {busy && <p role="status">{progress || "Importing…"}</p>}
        <DialogFooter><Button variant="outline" disabled={locked} onClick={() => step ? setStep(step - 1) : setFolder(undefined)}>{step ? "Back" : "Cancel"}</Button>{step < 3 ? <Button disabled={locked || !name.trim() || (step > 0 && !plan)} onClick={() => setStep(step + 1)}>Next</Button> : <Button disabled={locked || !plan || !name.trim()} onClick={() => void save()}>Import</Button>}</DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
    {summary && <Toast role="status" className="max-w-sm rounded-xl p-4 shadow-lg text-sm"><p>{summary.text}</p>{summary.details.length > 0 && <details className="mt-2 max-h-52 overflow-auto"><summary>{summary.details.length} warnings and skipped files</summary><ul className="mt-2 space-y-1">{summary.details.map((line,i) => <li key={i}>{line}</li>)}</ul></details>}<Button className="mt-2" size="sm" variant="ghost" onClick={() => setSummary(undefined)}>Dismiss</Button></Toast>}
  </>;
}
