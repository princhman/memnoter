import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { UpdateNotice } from "@/components/update-notice";
import { reportSyncRefusal } from "@/lib/update-required";
import { UPDATE_REQUIRED_MESSAGE } from "@/lib/sync/protocol";
import "@/App.css";

function Fixture() {
  const [page, setPage] = useState("Notes");
  return <><UpdateNotice /><main className="p-8">
    <h1>{page}</h1>
    <button onClick={() => setPage(page === "Notes" ? "Files" : "Notes")}>Navigate</button>
    <textarea aria-label="Local note" defaultValue="My local notes remain available." />
  </main></>;
}
Object.assign(window, { refuseSync: () => reportSyncRefusal(UPDATE_REQUIRED_MESSAGE) });
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
