import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "./ui/button";
import { Module } from "@/lib/types";

const RenameModule = ({
  moduleName,
  moduleId,
  open,
  onOpenChange,
}: {
  moduleName: string;
  moduleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const [name, setName] = useState(moduleName);
  const [sumbitted, setSubmitted] = useState(false);

  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (name: string) => {
      await invoke("rename_module", { moduleId, name });
    },
    onSuccess: () => {
      queryClient.setQueryData(["modules"], (oldData: any) =>
        oldData.map((module: Module) =>
          module.id === moduleId ? { ...module, name } : module,
        ),
      );
      setSubmitted(false);
      onOpenChange(false);
    },
  });

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename module</DialogTitle>
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
              {mutation.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RenameModule;
