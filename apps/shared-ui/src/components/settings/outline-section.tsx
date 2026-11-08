import { useSelector } from "@tanstack/react-store";
import { Switch } from "@/components/ui/switch";
import { appStore, setFoldableBlocksInOutline } from "@/lib/store";

export default function OutlineSection() {
  const foldableBlocks = useSelector(appStore, (state) => state.foldableBlocksInOutline);
  return (
    <section className="flex flex-col gap-3">
      <label className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">Foldable blocks in the outline</h2>
          <p className="text-sm text-muted-foreground">
            List each foldable block's title under its heading when you hover the outline.
          </p>
        </div>
        <Switch checked={foldableBlocks} onCheckedChange={setFoldableBlocksInOutline} />
      </label>
    </section>
  );
}
