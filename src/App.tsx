import CreateModule from "./create-module";
import Modules from "./modules";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();
const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="card">
        <CreateModule />
        <Modules />
      </div>
    </QueryClientProvider>
  );
};

export default App;
