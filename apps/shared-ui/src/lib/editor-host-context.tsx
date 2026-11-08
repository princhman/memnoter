import { createContext, useContext } from "react";
import { editorHost } from "./editor-host";

export const EditorHostContext = createContext(editorHost);
export const EditorHostProvider = EditorHostContext.Provider;
export const useEditorHost = () => useContext(EditorHostContext);
