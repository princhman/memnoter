import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call as invoke, capabilities } from "@/lib/backend";

type SpellingLanguages = { available: string[]; selected: string | null };

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });
const languageName = (tag: string) => {
  try { return languageNames.of(tag) ?? tag; } catch { return tag; }
};

// The editor's spell checker runs in the Windows display language unless the
// user picks one here. WebView2 reads it only at launch.
export default function SpellingSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["spelling-languages"],
    queryFn: () => invoke<SpellingLanguages>("spelling_languages"),
    enabled: capabilities.spelling,
  });
  const change = useMutation({
    mutationFn: (language: string | null) => invoke("set_spelling_language", { language }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["spelling-languages"] }),
  });
  if (!capabilities.spelling || !data?.available.length) return null;
  const selected = data.selected ?? "";
  return (
    <section className="flex flex-col gap-3">
      <label className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">Spelling language</h2>
          <p className="text-sm text-muted-foreground">
            The language the editor checks spelling in. Changes apply after you quit and reopen Memnoter.
          </p>
        </div>
        <select value={selected} disabled={change.isPending}
          onChange={event => change.mutate(event.target.value || null)}
          className="w-44 shrink-0 rounded bg-muted px-2 py-1 text-sm text-foreground">
          <option value="">Windows display language</option>
          {data.available.map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
        </select>
      </label>
      {change.isError && <p role="alert" className="text-sm text-destructive">{String(change.error)}</p>}
    </section>
  );
}
