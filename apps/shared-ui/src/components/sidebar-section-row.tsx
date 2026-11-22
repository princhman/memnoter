import { SidebarMenuItem, SidebarMenuButton } from "./ui/sidebar";
import { MiddleTruncate } from "./middle-truncate";

export function SidebarSectionRow({ title, number, selected, onClick }: {
  title: string; number?: string; selected: boolean; onClick: () => void;
}) {
  return <SidebarMenuItem>
    <SidebarMenuButton isActive={selected} aria-current={selected ? "location" : undefined}
      title={number ? `${number} ${title}` : title} onClick={onClick}>
      {number && <span className="shrink-0 tabular-nums text-muted-foreground">{number}</span>}
      <MiddleTruncate text={title} />
    </SidebarMenuButton>
  </SidebarMenuItem>;
}
