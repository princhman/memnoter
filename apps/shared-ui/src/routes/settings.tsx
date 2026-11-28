import { useSelector } from "@tanstack/react-store";
import { Switch } from "@/components/ui/switch";
import { appStore, setAutoCorrectPastedImages } from "@/lib/store";
import { createFileRoute, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import AboutSection from "@/components/settings/about-section";
import LocalBackupSection from "@/components/settings/local-backup-section";
import BackupsSection from "@/components/settings/backups-section";
import NumberingSection from "@/components/settings/numbering-section";
import OutlineSection from "@/components/settings/outline-section";
import ReviewSection from "@/components/settings/review-section";
import SpellingSection from "@/components/settings/spelling-section";
import { capabilities, isSecondaryWindow, call } from "@/lib/backend";
import { toast } from "sonner";
import SyncSection from "@/components/settings/sync-section";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const autoCorrectPastedImages = useSelector(appStore, state => state.autoCorrectPastedImages);
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const goBack = () => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/", replace: true });
  };

  const secondary = isSecondaryWindow();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 pb-16">
      <div className="flex items-center gap-2">
        <IconTooltip label="Back">
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={goBack}><ArrowLeft /></Button>
        </IconTooltip>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>
      {secondary ? <Button variant="outline" className="self-start" onClick={() => {
        void call("show_main_settings").catch(error => toast.error(error.message));
      }}>Open sync and backups in main window</Button> : <SyncSection />}
      <ReviewSection />
      <NumberingSection />
      <OutlineSection />
      <section>
        <label className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">Auto-correct pasted images</h2>
            <p className="text-sm text-muted-foreground">
              Adjust contrast and white balance when you paste or drop an image into a note.
            </p>
          </div>
          <Switch checked={autoCorrectPastedImages} onCheckedChange={setAutoCorrectPastedImages} />
        </label>
      </section>
      <SpellingSection />
      {capabilities.localBackup && <LocalBackupSection />}
      {!secondary && <BackupsSection />}
      <AboutSection />
    </div>
  );
}
