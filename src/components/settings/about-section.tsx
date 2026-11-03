import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";

export default function AboutSection() {
  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    staleTime: Infinity,
  });
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-medium">About</h2>
      <p className="text-sm text-muted-foreground">
        Memnoter{version ? ` v${version}` : ""}
      </p>
    </section>
  );
}
