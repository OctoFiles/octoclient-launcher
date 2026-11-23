const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateFormatter.format(date);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "noch nie online";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unbekannt";
  const seconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "gerade eben";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} Tag${days === 1 ? "" : "en"}`;
  return formatDate(iso);
}

export function formatMemory(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "unbekannt";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function shortUuid(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 8);
}

export function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}
