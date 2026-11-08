import { createFileRoute, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/icon-tooltip";
import AboutSection from "@/components/settings/about-section";
import BackupsSection from "@/components/settings/backups-section";
import NumberingSection from "@/components/settings/numbering-section";
import ReviewSection from "@/components/settings/review-section";
import SyncSection from "@/components/settings/sync-section";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const goBack = () => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/", replace: true });
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 pb-16">
      <div className="flex items-center gap-2">
        <IconTooltip label="Back">
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={goBack}><ArrowLeft /></Button>
        </IconTooltip>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>
      <SyncSection />
      <ReviewSection />
      <NumberingSection />
      <BackupsSection />
      <AboutSection />
    </div>
  );
}
