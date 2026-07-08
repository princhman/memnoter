import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

type Module = {
  id: string;
  name: string;
};

const Modules = () => {
  const { isPending, error, data } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });

  if (isPending) return "Loading...";

  if (error) return "An error has occurred: " + error.message;

  return (
    <div>
      <h1>Modules</h1>
      <ul>
        {data.map((module) => (
          <li key={module.id}>{module.name}</li>
        ))}
      </ul>
    </div>
  );
};
export default Modules;
