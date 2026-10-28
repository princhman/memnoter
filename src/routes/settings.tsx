import { createFileRoute } from "@tanstack/react-router";
import BackupsSection from "@/components/settings/backups-section";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 pb-16">
      <h1 className="text-xl font-semibold">Settings</h1>
      <BackupsSection />
    </div>
  );
}
