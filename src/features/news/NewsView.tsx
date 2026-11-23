import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import { NEWS_CATEGORY_LABELS } from "../../data/news";
import { formatDate } from "../../lib/format";
import type { NewsCategory } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import "./news.css";

type Filter = "all" | NewsCategory;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "patch", label: "Patches" },
  { id: "update", label: "Updates" },
  { id: "info", label: "Infos" },
];

export function NewsView() {
  const { news, newsSource, refreshNews } = useLauncher();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(news[0]?.id ?? null);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return news
      .filter((item) => filter === "all" || item.category === filter)
      .filter((item) => {
        if (!term) return true;
        return (
          item.title.toLowerCase().includes(term) ||
          item.summary.toLowerCase().includes(term) ||
          item.version.toLowerCase().includes(term) ||
          item.tags.some((tag) => tag.toLowerCase().includes(term))
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [news, filter, query]);

  return (
    <div className="view news-view">
      <header className="view-head">
        <div>
          <span className="eyebrow">Changelog & Neuigkeiten</span>
          <h1 className="view-title">News & Patches</h1>
          <p className="view-sub">
            {newsSource === "remote"
              ? "Remote-Feed aktiv — lokale Meldungen bleiben als Fallback erhalten."
              : "Lokaler Feed. Ein Remote-Feed lässt sich in den Einstellungen anbinden."}
          </p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} />}
          onClick={() => void refreshNews()}
        >
          Aktualisieren
        </Button>
      </header>

      <div className="news-toolbar">
        <div className="chips" role="group" aria-label="Kategorie filtern">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={["chip", filter === entry.id ? "chip--active" : ""].filter(Boolean).join(" ")}
              onClick={() => setFilter(entry.id)}
              aria-pressed={filter === entry.id}
            >
              {entry.label}
              <span className="chip__count">
                {entry.id === "all"
                  ? news.length
                  : news.filter((item) => item.category === entry.id).length}
              </span>
            </button>
          ))}
        </div>

        <label className="search-field">
          <Search size={14} />
          <input
            type="search"
            placeholder="Suche in Titel, Version, Tags…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>Keine Meldungen passen zu deinem Filter.</p>
        </div>
      ) : (
        <div className="news-list">
          {visible.map((item) => {
            const open = expanded === item.id;
            return (
              <article key={item.id} className={["news-card", open ? "news-card--open" : ""].filter(Boolean).join(" ")}>
                <button
                  type="button"
                  className="news-card__head"
                  onClick={() => setExpanded(open ? null : item.id)}
                  aria-expanded={open}
                >
                  <div className="news-card__meta">
                    <span className={`badge badge--${item.category}`}>
                      {NEWS_CATEGORY_LABELS[item.category]}
                    </span>
                    {item.version ? <span className="badge badge--ghost">v{item.version}</span> : null}
                    <time dateTime={item.date}>{formatDate(item.date)}</time>
                  </div>
                  <h2>{item.title}</h2>
                  <p>{item.summary}</p>
                  <div className="news-card__foot">
                    <div className="tag-row">
                      {item.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <ChevronDown
                      size={16}
                      className={["news-card__chevron", open ? "news-card__chevron--open" : ""].filter(Boolean).join(" ")}
                    />
                  </div>
                </button>

                {open ? (
                  <div className="news-card__body">
                    <ul>
                      {item.body.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
