import type { Editor } from "@tiptap/core";
import {
  createContext,
  type ReactNode,
  useState,
  type Dispatch,
  type SetStateAction,
  useContext,
} from "react";

type ActiveEditor = { moduleId: string; editor: Editor };

const Context = createContext<{
  activeEditor: ActiveEditor | null;
  setActiveEditor: Dispatch<SetStateAction<ActiveEditor | null>>;
} | null>(null);

export function ActiveEditorProvider({ children }: { children: ReactNode }) {
  const [activeEditor, setActiveEditor] = useState<ActiveEditor | null>(null);

  return (
    <Context.Provider value={{ activeEditor, setActiveEditor }}>
      {children}
    </Context.Provider>
  );
}

export function useActiveEditor() {
  const context = useContext(Context);
  if (!context) throw new Error("ActiveEditorProvider is missing");
  return context;
}
