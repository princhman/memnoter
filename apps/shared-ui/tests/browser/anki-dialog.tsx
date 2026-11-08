import { createRoot } from "react-dom/client";
import { ImportAnkiDialog } from "@/components/import-anki";
import { importAnki } from "@/lib/import-anki";
import { prepareAnkiImport, defaultSelection } from "@/lib/anki-import";
import { call } from "@/lib/backend";
import "@/App.css";
Object.assign(window, { importAnki, prepareAnkiImport, defaultSelection, call });
createRoot(document.getElementById("root")!).render(<ImportAnkiDialog onImported={async () => {}} />);
