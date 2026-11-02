import { exclusiveWrite } from "@/lib/write-lifecycle";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { Module } from "@/lib/types";
import { dueCountsKey } from "@/lib/card-sync";
import { forgetModule } from "@/lib/store";
import { saveQueue } from "@/lib/saves";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const DeleteModule = ({
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
  const queryClient = useQueryClient();
  const router = useRouter();
  const mutation = useMutation({
    mutationKey: ["delete-module"],
    mutationFn: () => exclusiveWrite(async () => {
      await invoke("delete_module", { moduleId });
      saveQueue.drop(moduleId);
      forgetModule(moduleId);
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
      if (
        router.state.matches.some(
          (match) =>
            "moduleId" in match.params && match.params.moduleId === moduleId,
        )
      ) {
        await router.navigate({ to: "/", replace: true });
      }
      await queryClient.cancelQueries({ queryKey: ["content", moduleId] });
      queryClient.removeQueries({ queryKey: ["content", moduleId] });
      onOpenChange(false);
      queryClient.setQueryData<Module[]>(["modules"], (modules) =>
        modules?.filter((module) => module.id !== moduleId),
      );
    }, { excludedMutation: "delete-module" }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (mutation.isPending) return;
        mutation.reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent showCloseButton={!mutation.isPending}>
        <DialogHeader>
          <DialogTitle>Delete module?</DialogTitle>
          <DialogDescription>
            This will permanently delete “{moduleName}” and all its content and
            images. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {String(mutation.error)}
          </p>
        )}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting..." : "Delete module"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteModule;
