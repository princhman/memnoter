import { ImportAnkiDialog } from "./import-anki";
import { IMPORT_ANKI_EVENT, IMPORT_FOLDER_EVENT } from "@/lib/app-events";
import { modulesCache } from "@/lib/modules";
import { capabilities } from "@/lib/backend";
import { ImportFolderDialog } from "./import-folder";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { call as invoke } from "../lib/backend.ts";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { NEW_MODULE_EVENT } from "@/lib/app-events";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "./ui/button";
import { SidebarGroupAction } from "./ui/sidebar";
import { useCommand, registerCommand } from "@/lib/commands";
import { IconTooltip } from "./icon-tooltip";

export function CreateModuleButton({ onNewFolder }: { onNewFolder?: () => void }) {
  return <DropdownMenu>
    <IconTooltip label="Add module" side="right"><DropdownMenuTrigger render={<SidebarGroupAction aria-label="Add module" className="invisible group-hover:visible pointer-coarse:visible" />}><Plus className="size-3" /></DropdownMenuTrigger></IconTooltip>
    <DropdownMenuContent side="right" className="w-auto">
      <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(NEW_MODULE_EVENT))}>New module</DropdownMenuItem>
      {onNewFolder && <DropdownMenuItem onClick={onNewFolder}>New folder</DropdownMenuItem>}
      {capabilities.folderImport && <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(IMPORT_ANKI_EVENT))}>Import Anki deck…</DropdownMenuItem>}
      {capabilities.folderImport && <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(IMPORT_FOLDER_EVENT))}>Import folder…</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

const CreateModule = () => {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [sumbitted, setSubmitted] = useState(false);

  const openDialog = useCallback(() => setOpen(true), []);

  // The app menu and the welcome screen ask for the dialog too.
  useEffect(() => {
    const handleOpen = openDialog;
    window.addEventListener(NEW_MODULE_EVENT, handleOpen);
    return () => window.removeEventListener(NEW_MODULE_EVENT, handleOpen);
  }, [openDialog]);

  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: async (name: string) =>
      invoke<string>("create_module", { name }),
    onSuccess: (moduleId) => {
      modulesCache.invalidate();
      setName("");
      setSubmitted(false);
      setOpen(false);
      void navigate({ to: "/$moduleId", params: { moduleId } });
    },
  });

  const openImport = () => { window.dispatchEvent(new Event(IMPORT_FOLDER_EVENT)); };
  useCommand({ id: "module.new", title: "New module", keywords: ["create", "note"], run: openDialog });
  useEffect(() => capabilities.folderImport ? registerCommand({ id: "module.import", title: "Import folder…", keywords: ["obsidian", "markdown"], run: openImport }) : undefined, []);


  useEffect(() => capabilities.folderImport ? registerCommand({ id: "module.importAnki", title: "Import Anki deck…", keywords: ["apkg", "flashcards"], run: () => { window.dispatchEvent(new Event(IMPORT_ANKI_EVENT)); } }) : undefined, []);

  const trimmedName = name.trim();

  const nameError =
    sumbitted && !trimmedName ? "Module name is required" : undefined;

  const sumbitError = mutation.isError ? mutation.error.message : undefined;

  const error = nameError ?? sumbitError;

  const handleSubmit = (event: React.SubmitEvent) => {
    event.preventDefault();
    setSubmitted(true);

    if (!trimmedName) return;

    mutation.mutate(trimmedName);
  };

  return (
    <>
    {capabilities.folderImport && <ImportAnkiDialog onImported={async moduleId => { await modulesCache.invalidate(); void navigate({ to: "/$moduleId", params: { moduleId } }); }} />}
    {capabilities.folderImport && <ImportFolderDialog onImported={async moduleId => {
      await modulesCache.invalidate();
      void navigate({ to: "/$moduleId", params: { moduleId } });
    }} />}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create new module</DialogTitle>
          </DialogHeader>
          <FieldGroup className="pb-2 pt-4">
            <Field data-invalid={!!error}>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mathematics"
                aria-invalid={!!error}
                aria-describedby={error ? "module-name-error" : undefined}
                disabled={mutation.isPending}
              />
              <FieldError id="module-name-error">{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
};

export default CreateModule;
