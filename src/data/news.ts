import type { NewsItem } from "../lib/types";

/**
 * Curated local feed — always available offline.
 * A remote feed can be configured in the settings; its items are merged by id.
 */
export const NEWS_ITEMS: NewsItem[] = [
  {
    id: "frost-0-1-0",
    title: "OctoClient 0.1.0 — Der Launcher ist da",
    category: "update",
    version: "0.1.0",
    date: "2026-11-22",
    summary:
      "Der neue Launcher bringt echten Microsoft-Login, eine überarbeitete 3D-Bühne mit Cape-Physik und ein aufgeräumtes Einstellungsmenü.",
    body: [
      "Microsoft-Anmeldung über den offiziellen Device-Code-Flow inklusive Token-Refresh.",
      "3D-Spielerfigur neu aufgebaut: Kopf, Overlay und Nametag sitzen jetzt Pixel-genau.",
      "Capes hängen an den Schultern und schwingen physikalisch statt starr zu rotieren.",
      "Freundesliste startet leer und wird lokal gespeichert.",
      "Shop entfernt — der Launcher konzentriert sich auf Spielen, News, Kosmetik und Einstellungen.",
    ],
    tags: ["Launcher", "Release"],
  },
  {
    id: "mc-1-21-10",
    title: "Minecraft 1.21.10 Support",
    category: "patch",
    version: "1.21.10",
    date: "2026-10-02",
    summary:
      "OctoClient unterstützt 1.21.10 vollständig — inklusive aktualisierter Startargumente und Asset-Indizes.",
    body: [
      "Neue Version als Standardprofil hinterlegt.",
      "Java 21 wird für 1.21.10 empfohlen.",
      "Mod-Profile werden beim Wechsel der Version neu aufgelöst.",
    ],
    tags: ["Minecraft", "Kompatibilität"],
  },
  {
    id: "cape-aurora",
    title: "Neue Capes: Aurora & Void",
    category: "info",
    version: "0.1.0",
    date: "2026-09-18",
    summary:
      "Zwei neue Capes sind im Bereich Skins & Kosmetik verfügbar und lassen sich direkt in der 3D-Vorschau testen.",
    body: [
      "Aurora: Gradient aus Cyan und Violett mit Schneekristall-Emblem.",
      "Void: tiefschwarzer Stoff mit Sternenstaub.",
      "Capes werden lokal gespeichert und beim nächsten Start wieder geladen.",
    ],
    tags: ["Kosmetik", "Capes"],
  },
  {
    id: "performance-mode",
    title: "Galaxy-Hintergrund mit Performance-Stufen",
    category: "patch",
    version: "0.1.0",
    date: "2026-08-30",
    summary:
      "Der Sternenhimmel lässt sich in drei Stufen betreiben — für schwache Systeme ohne Einbußen beim Launcher-Feeling.",
    body: [
      "Hoch: Parallaxe, Sternschnuppen und feiner Nebel.",
      "Ausgewogen: ruhige Sterne mit gelegentlichen Sternschnuppen.",
      "Niedrig: statisches Bild, minimaler Verbrauch.",
      "Zusätzlich lässt sich „Bewegung reduzieren“ aktivieren.",
    ],
    tags: ["Performance", "UI"],
  },
  {
    id: "account-security",
    title: "So speichert der Launcher deine Sitzung",
    category: "info",
    version: "0.1.0",
    date: "2026-08-12",
    summary:
      "Refresh-Tokens liegen im Windows-Anmeldeinformationsspeicher — nicht im Klartext im Projektordner.",
    body: [
      "Die Anmeldung läuft ausschließlich über Microsoft; Passwörter sieht der Launcher nie.",
      "Der Refresh-Token wird im OS-Schlüsselspeicher abgelegt.",
      "Abmelden löscht die gespeicherte Sitzung vollständig.",
      "Fällt kein Schlüsselspeicher verfügbar aus, wird eine Datei mit Hinweis im Log verwendet.",
    ],
    tags: ["Sicherheit", "Account"],
  },
];

export const NEWS_CATEGORY_LABELS: Record<NewsItem["category"], string> = {
  patch: "Patch",
  update: "Update",
  info: "Info",
};
