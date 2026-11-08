import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { syncedFilesStore } from "./sync/file-requests";
import { listDocuments } from "./documents";
export const documentsKey = ["documents"];
export function useDocuments(moduleId?: string) {
  const version = useSelector(syncedFilesStore, state => state.version);
  const client = useQueryClient();
  useEffect(() => { void client.invalidateQueries({ queryKey: documentsKey }); }, [client, version]);
  return useQuery({ queryKey: [...documentsKey, moduleId ?? null], queryFn: () => listDocuments({ moduleId }) });
}
