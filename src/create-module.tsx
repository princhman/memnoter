import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

const CreateModule = () => {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (name: string) => {
      await invoke("create_module", { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["modules"] });
    },
  });

  const handleSubmit = (event: React.SubmitEvent) => {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) return;

    mutation.mutate(trimmedName);
  };

  return (
    <div>
      <h1>Create Module</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          name="name"
          placeholder="Module Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating..." : "Submit"}
        </button>
      </form>
    </div>
  );
};

export default CreateModule;
