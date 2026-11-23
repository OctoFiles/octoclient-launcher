import {
  Gamepad2,
  Layers,
  Newspaper,
  Settings,
  Shirt,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { PageId } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import "./sidebar.css";

interface NavEntry {
  id: PageId;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const NAV: NavEntry[] = [
  { id: "play", label: "Spielen", icon: Gamepad2, hint: "Start & Favoriten" },
  { id: "friends", label: "Freunde", icon: Users, hint: "Freunde & Chat" },
  { id: "instances", label: "Instanzen", icon: Layers, hint: "Versionen & Mod-Profile" },
  { id: "news", label: "News", icon: Newspaper, hint: "Patches & Updates" },
  { id: "skins", label: "Skins", icon: Shirt, hint: "Capes & Kosmetik" },
  { id: "settings", label: "Settings", icon: Settings, hint: "Launcher & Java" },
];

interface SidebarProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
}

export function Sidebar({ page, onNavigate }: SidebarProps) {
  const { unreadMessages } = useLauncher();

  return (
    <nav className="sidebar" aria-label="Hauptnavigation">
      <div className="sidebar__nav">
        {NAV.map((entry) => {
          const Icon = entry.icon;
          const active = entry.id === page;
          return (
            <button
              key={entry.id}
              type="button"
              className={["nav-item", active ? "nav-item--active" : ""].filter(Boolean).join(" ")}
              onClick={() => onNavigate(entry.id)}
              aria-current={active ? "page" : undefined}
              title={entry.hint}
            >
              <span className="nav-item__icon">
                <Icon size={19} strokeWidth={1.9} />
              </span>
              <span className="nav-item__label">{entry.label}</span>
              {entry.id === "friends" && unreadMessages > 0 ? (
                <span className="nav-item__badge" aria-label={`${unreadMessages} ungelesene Nachrichten`}>
                  {unreadMessages > 99 ? "99+" : unreadMessages}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
