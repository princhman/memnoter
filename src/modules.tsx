import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import Tiptap from "./Tiptap";

type Module = {
  id: string;
  name: string;
};

const Modules = () => {
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const { isPending, error, data } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });

  if (isPending) return "Loading...";

  if (error) return "An error has occurred: " + error.message;

  const selectedModule = data.find((module) => module.id === selectedModuleId);

  return (
    <div>
      <h1>Modules</h1>
      <ul>
        {data.map((module) => (
          <li key={module.id}>
            <button
              type="button"
              onClick={() => setSelectedModuleId(module.id)}
            >
              {module.name}
            </button>
          </li>
        ))}
      </ul>

      {selectedModule ? (
        <div>
          <h2>{selectedModule.name}</h2>
          <Tiptap key={selectedModule.id} moduleId={selectedModule.id} />
        </div>
      ) : (
        <p>Select a module to start editing</p>
      )}
    </div>
  );
};
export default Modules;
