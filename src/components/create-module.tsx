import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { NEW_MODULE_EVENT } from "@/lib/app-events";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "./ui/button";
import { SidebarGroupAction } from "./ui/sidebar";

const CreateModule = () => {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [sumbitted, setSubmitted] = useState(false);

  // The app menu and the welcome screen ask for the dialog too.
  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(NEW_MODULE_EVENT, handleOpen);
    return () => window.removeEventListener(NEW_MODULE_EVENT, handleOpen);
  }, []);

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (name: string) =>
      invoke<string>("create_module", { name }),
    onSuccess: (moduleId) => {
      queryClient.invalidateQueries({ queryKey: ["modules"] });
      setName("");
      setSubmitted(false);
      setOpen(false);
      void navigate({ to: "/$moduleId", params: { moduleId } });
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <SidebarGroupAction
            aria-label="Add Module"
            className="invisible group-hover:visible"
          />
        }
      >
        <Plus className="size-3" />
      </DialogTrigger>
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
  );
};

export default CreateModule;
