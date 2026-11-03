import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "@/components/ui/switch";
import type { Module } from "@/lib/types";

const ModuleNumbering = ({ module }: { module: Module }) => {
  const client = useQueryClient();
  const numbering = useMutation({
    mutationFn: (enabled: boolean) =>
      invoke("set_module_numbering", { moduleId: module.id, enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["modules"] }),
  });
  return (
    <li className="flex flex-col gap-1">
      <label className="flex items-center justify-between gap-4 text-sm">
        <span className="truncate">{module.name}</span>
        <Switch
          checked={module.heading_numbering}
          disabled={numbering.isPending}
          onCheckedChange={(enabled) => numbering.mutate(enabled)}
        />
      </label>
      {numbering.isError && (
        <p role="alert" className="text-sm text-destructive">{String(numbering.error)}</p>
      )}
    </li>
  );
};

export default function NumberingSection() {
  const { data: modules } = useQuery({
    queryKey: ["modules"],
    queryFn: () => invoke<Module[]>("modules"),
  });
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Chapter numbering</h2>
        <p className="text-sm text-muted-foreground">
          Number headings (1, 1.1, 2 …) in a module's notes and outline. The numbers
          are only shown on screen and never added to the note text.
        </p>
      </div>
      {modules?.length ? (
        <ul className="flex flex-col gap-2">
          {modules.map((module) => <ModuleNumbering key={module.id} module={module} />)}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No modules yet.</p>
      )}
    </section>
  );
}
