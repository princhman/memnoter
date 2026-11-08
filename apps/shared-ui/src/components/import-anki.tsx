import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { IMPORT_ANKI_EVENT } from "@/lib/app-events";
import { call } from "@/lib/backend";
import { deckTree, defaultSelection, prepareAnkiImport, type AnkiSelection, type DeckNode, type DeckRole } from "@/lib/anki-import";
import { importAnki, type AnkiSession } from "@/lib/import-anki";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { importToast } from "@/lib/import-toast";

export function ImportAnkiDialog({ onImported }: { onImported: (id: string) => Promise<void> }) {
  const [session, setSession] = useState<AnkiSession>();
  const active = useRef<AnkiSession | undefined>(undefined);
  const busyRef = useRef(false);
  const [selection, setSelection] = useState<AnkiSelection>({ roles: {} });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const close = () => { setSession(undefined); };
  useEffect(() => {
    let picking = false;
    let mounted = true;
    const pick = async () => {
      if (picking || active.current || busyRef.current) return;
      picking = true;
      try {
        const selected = await call<AnkiSession | null>("pick_anki_package");
        if (!selected) return;
        if (!mounted) { await call("close_anki_package", { sourceId: selected.sourceId }); return; }
        active.current = selected;
        setSelection(defaultSelection(selected.package.decks));
        setStep(0); setError(""); setAttempted(false); setSession(selected);
      } catch (e) { if (mounted) importToast("error", "Could not open Anki package", [String(e)], "error details"); }
      finally { picking = false; }
    };
    window.addEventListener(IMPORT_ANKI_EVENT, pick);
    return () => { mounted = false; window.removeEventListener(IMPORT_ANKI_EVENT, pick); };
  }, []);
  useEffect(() => {
    if (!session) return;
    return () => {
      active.current = undefined;
      void call("close_anki_package", { sourceId: session.sourceId }).catch(e => console.error("Could not release Anki package", e));
    };
  }, [session]);
  const plan = useMemo(() => session ? prepareAnkiImport(session.package, selection) : undefined, [session, selection]);
  const tree = useMemo(() => deckTree(session?.package.decks ?? []), [session]);
  const names = plan?.modules.map(m => selection.names?.[m.key] ?? m.name) ?? [];
  const invalid = !plan?.modules.length || names.some(n => !n.trim()) || new Set(names.map(n => n.trim())).size !== names.length;
  const changeRole = (node: DeckNode, role: DeckRole) => {
    const roles = { ...selection.roles, [node.key]: role };
    const children = (parent: DeckNode) => parent.children.forEach(child => {
      if (role === "module") roles[child.key] = "heading";
      else if (role === "skip") roles[child.key] = "skip";
      else if (roles[child.key] === "module") return;
      children(child);
    });
    children(node);
    setSelection({ ...selection, roles });
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; });
  // One row per deck: disclosure, name with its card count, and its role.
  const renderNode = (node: DeckNode, ancestor: boolean, depth = 0): ReactNode => {
    if (!node.total) return null;
    const role = selection.roles[node.key] ?? "skip";
    const nested = node.children.filter(child => child.total);
    const open = !collapsed.has(node.key);
    return <div key={node.key}>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${depth}rem` }}>
        {nested.length
          ? <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={open} onClick={() => toggle(node.key)} className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted">
              <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
            </button>
          : <span className="size-5 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{node.name} <span className="text-muted-foreground">{node.total} {node.total === 1 ? "card" : "cards"}</span></span>
        <select aria-label={`Role for ${node.key}`} value={role} disabled={busy} onChange={e => changeRole(node, e.target.value as DeckRole)} className="w-44 shrink-0 rounded bg-muted px-2 py-1 text-foreground">
          <option value="module">Module</option>
          {ancestor && <><option value="heading">Heading</option><option value="merge">Merge into parent</option></>}
          <option value="skip">Skip</option>
        </select>
      </div>
      {open && nested.map(child => renderNode(child, role === "module" || (ancestor && role !== "skip"), depth + 1))}
    </div>;
  };
  const save = async () => {
    if (!session || !plan || invalid || attempted) return;
    setBusy(true); busyRef.current = true; setError(""); setAttempted(true);
    try {
      const result = await importAnki(session, plan, setProgress);
      close();
      importToast("success", `Imported ${result.modules.length} modules and ${result.cards} cards.`, result.warnings, result.warnings.length === 1 ? "warning" : "warnings");
      if (result.modules[0]) await onImported(result.modules[0].id);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); busyRef.current = false; }
  };
  return <>
    <Dialog open={!!session} onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85dvh] flex flex-col overflow-hidden">
        <DialogHeader><DialogTitle>Import Anki deck: {["Choose decks", "Name modules and folders", "Review"][step]}</DialogTitle></DialogHeader>
        <div className="min-h-0 overflow-auto space-y-3 text-sm">
          <p>{session?.fileName}</p>
          {step === 0 && tree.map(node => renderNode(node, false))}
          {step === 1 && plan?.modules.map(module => <section key={module.key} className="space-y-2">
            <h3>{module.key} ({module.cards} cards)</h3>
            <label className="block">Module name<Input value={selection.names?.[module.key] ?? module.name} onChange={e => setSelection({ ...selection, names: { ...selection.names, [module.key]: e.target.value } })} /></label>
            <label className="block">Folder<Input value={selection.folders?.[module.key] ?? ""} placeholder="No folder" onChange={e => setSelection({ ...selection, folders: { ...selection.folders, [module.key]: e.target.value } })} /></label>
          </section>)}
          {step > 0 && <p>{plan?.modules.length} modules, {plan?.cards} cards, {plan?.images.length} images and {plan?.warnings.length} warnings.</p>}
          {step === 2 && <ul>{plan?.modules.map(m => <li key={m.key}>{m.name}{m.folder ? ` in ${m.folder}` : ""}: {m.cards} cards</li>)}</ul>}
          {!!plan?.warnings.length && <details><summary>Import warnings</summary><ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
          {invalid && step === 1 && <p role="alert">Choose at least one module and give each module a unique, non-empty name.</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {busy && <p role="status">{progress}</p>}
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>{step > 0 && <Button variant="outline" disabled={busy || attempted} onClick={() => setStep(step - 1)}>Back</Button>}
          {step < 2 ? <Button disabled={invalid} onClick={() => setStep(step + 1)}>Next</Button> : <Button disabled={busy || invalid || attempted} onClick={() => void save()}>Import</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
