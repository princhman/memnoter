import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { call as invoke } from "../lib/backend.ts";
import { ChevronDown } from "lucide-react";
import { openReview } from "@/lib/card-sync";
import { Module } from "@/lib/types";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Picks which module's cards the review shows, or all of them.
export function ReviewScopeMenu() {
  const { data: modules = [] } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => await invoke<Module[]>("modules"),
  });
  const search = useSearch({ strict: false });
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="xs" className="-mx-2 min-w-0 max-w-56 text-sm font-bold text-foreground" aria-label="Select review module">
            <span className="truncate">
              {search.module ? (modules.find((module) => module.id === search.module)?.name || "Module") : "All modules"}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-48 max-w-80">
        <DropdownMenuRadioGroup
          value={search.module ?? ""}
          onValueChange={(value) => {
            if (value === (search.module ?? "")) return;
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
