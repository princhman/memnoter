import { useModules } from "@/lib/modules";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { openReview } from "@/components/card-navigation-guard";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Picks which module's cards the review shows, or all of them. Files uses the
// same menu; the reader passes the open PDF's module as the current one.
export function ReviewScopeMenu({ page = "review", current }: { page?: "review" | "files"; current?: string }) {
  const { data: modules = [] } = useModules();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const selected = current ?? search.module;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="xs" className="-mx-2 min-w-0 max-w-56 text-sm font-bold text-foreground" aria-label={page === "files" ? "Select files module" : "Select review module"}>
            <span className="truncate">
              {selected ? (modules.find((module) => module.id === selected)?.name || "Module") : "All modules"}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-48 max-w-80">
        <DropdownMenuRadioGroup
          value={selected ?? ""}
          onValueChange={(value) => {
            if (page === "files") {
              void navigate({ to: "/files", search: value ? { module: value } : {} });
              return;
            }
            if (value === (selected ?? "")) return;
            void openReview(() => navigate({ to: "/review", search: value ? { module: value } : {} }));
          }}
        >
          <DropdownMenuRadioItem value="" closeOnClick>All modules</DropdownMenuRadioItem>
          {modules.map((module) => (
            <DropdownMenuRadioItem key={module.id} value={module.id} closeOnClick>
              <span className="truncate">{module.name || "Untitled module"}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
