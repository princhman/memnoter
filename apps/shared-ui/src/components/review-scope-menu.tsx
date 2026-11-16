import { useModules } from "@/lib/modules";
import { useSearch } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useModuleSectionNavigation, type ModuleSection } from "./module-section-menu";
import { Button } from "./ui/button";
import { MiddleTruncate } from "./middle-truncate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Notes need one module; the shared sections also allow All modules.
export function ReviewScopeMenu({ page = "review", current }: { page?: ModuleSection; current?: string }) {
  const { data: modules = [] } = useModules();
  const search = useSearch({ strict: false });
  const navigateSection = useModuleSectionNavigation();
  const selected = current ?? search.module;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="xs" className="-ml-1.5 inline-flex! min-w-0 max-w-56! gap-2 px-1.5 text-sm font-bold text-foreground" aria-label={`Select ${page} module`}>
            <MiddleTruncate text={selected ? (modules.find((module) => module.id === selected)?.name || "Module") : "All modules"} />
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-48 max-w-80">
        <DropdownMenuRadioGroup
          value={selected ?? ""}
          onValueChange={(value) => {
            if (page !== "files" && value === (selected ?? "")) return;
            void navigateSection(page, value || undefined);
          }}
        >
          {(page !== "notes") && <DropdownMenuRadioItem value="" showIndicator={false} closeOnClick>All modules</DropdownMenuRadioItem>}
          {modules.map((module) => (
            <DropdownMenuRadioItem key={module.id} value={module.id} showIndicator={false} closeOnClick>
              <MiddleTruncate text={module.name || "Untitled module"} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
