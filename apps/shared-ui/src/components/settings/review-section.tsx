import { useSelector } from "@tanstack/react-store";
import { Switch } from "@/components/ui/switch";
import { appStore, setLearnAhead } from "@/lib/store";
import { LEARN_AHEAD_MS } from "@/lib/fsrs";

export default function ReviewSection() {
  const learnAhead = useSelector(appStore, (state) => state.learnAhead);
  return (
    <section className="flex flex-col gap-3">
      <label className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">Learn ahead</h2>
          <p className="text-sm text-muted-foreground">
            When no card is due, show one due in the next {LEARN_AHEAD_MS / 60_000} minutes
            instead of waiting for it, as Anki does.
          </p>
        </div>
        <Switch checked={learnAhead} onCheckedChange={setLearnAhead} />
      </label>
    </section>
  );
}
