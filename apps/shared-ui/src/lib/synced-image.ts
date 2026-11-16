import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { call, fileUrl } from "./backend";
import { requestSyncedFile, syncedFilesStore } from "./sync/file-requests";

/** A synced image's URL. Content can arrive before its file, so a miss asks sync
 *  for the file and retries when a download lands, like SavedImageView. */
export function useSyncedImageUrl(key: string, fileId: string) {
  const arrived = useSelector(syncedFilesStore, state => state.version);
  const image = useQuery({ queryKey: [key, fileId], queryFn: () => call<string>("resolve_card_image", { fileId }).then(fileUrl), retry: false, staleTime: Infinity });
  const { isError, refetch } = image;
  useEffect(() => { if (isError) requestSyncedFile(fileId); }, [isError, fileId]);
  useEffect(() => { if (isError) void refetch(); }, [arrived]);
  return image;
}
