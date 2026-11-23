import {
  Check,
  Film,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Smile,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Segmented";
import { errorMessage } from "../../lib/bridge";
import {
  friendsApi,
  type ChatMessage,
  type FriendStatus,
  type FriendView,
  type FriendsSnapshot,
  type GroupView,
} from "../../lib/friends";
import "./friends.css";

const STATUS_LABEL: Record<string, string> = {
  online: "Online",
  ingame: "Im Spiel",
  away: "Abwesend",
  offline: "Offline",
};

const EMOJIS = [
  "😀", "😂", "😅", "😊", "😍", "😎",
  "🤔", "😴", "😭", "😡", "🥳", "🙃",
  "👍", "👎", "👏", "🙌", "🤝", "💪",
  "❤️", "🔥", "✨", "🎉", "💀", "🐙",
  "⛏️", "🗡️", "🛡️", "🧱", "🌲", "🌙",
  "☕", "🎮",
];

/** A message that is just an image/GIF link is rendered as the picture. */
const MEDIA_RE = /^https?:\/\/\S+\.(gif|webp|png|jpe?g)(\?\S*)?$/i;
const MAX_ATTACHMENT = 4_200_000;

type Target = { kind: "friend"; uuid: string } | { kind: "group"; id: number };

function statusText(friend: FriendView): string {
  if (friend.typing) return "schreibt …";
  if (friend.status === "ingame" && friend.detail) return friend.detail;
  return STATUS_LABEL[friend.status] ?? friend.status;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function isMedia(message: ChatMessage): boolean {
  const body = message.body.trim();
  return (
    message.kind === "gif" ||
    message.kind === "image" ||
    MEDIA_RE.test(body) ||
    body.startsWith("data:image/")
  );
}

/**
 * Friends tab: the account name is claimed on the shared OctoClient server on
 * first use, so adding a player by name and chatting needs no configuration.
 */
export function FriendsView() {
  const [snapshot, setSnapshot] = useState<FriendsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [thread, setThread] = useState<ChatMessage[]>([]);
  const [groupThread, setGroupThread] = useState<ChatMessage[]>([]);
  const [groupTyping, setGroupTyping] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [presence, setPresence] = useState<FriendStatus>("online");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifUrl, setGifUrl] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [groupForm, setGroupForm] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const typingSentAt = useRef(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await friendsApi.overview();
      setSnapshot(next);
      // The server reports the availability that is actually stored, so the
      // switch no longer snaps back to "online" (or to "offline") on refresh.
      setPresence((next.me.status as FriendStatus) || "online");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Heartbeat so the status dot of the other side stays honest.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), 8_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const loadThread = useCallback(async (next: Target) => {
    if (next.kind === "friend") {
      const result = await friendsApi.messages(next.uuid, 0);
      setThread(result.messages);
      setTyping(result.typing);
      return;
    }
    const result = await friendsApi.groupMessages(next.id, 0);
    setGroupThread(result.messages);
    setGroupTyping(result.typing);
  }, []);

  const openChat = useCallback(
    async (uuid: string) => {
      const next: Target = { kind: "friend", uuid };
      setTarget(next);
      setThread([]);
      setGroupThread([]);
      setTyping(false);
      setGroupTyping([]);
      setEditing(null);
      setEmojiOpen(false);
      setGifOpen(false);
      setAttachment(null);
      try {
        await loadThread(next);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [loadThread],
  );

  const openGroup = useCallback(
    async (group: GroupView) => {
      const next: Target = { kind: "group", id: group.id };
      setTarget(next);
      setThread([]);
      setGroupThread([]);
      setTyping(false);
      setGroupTyping([]);
      setEditing(null);
      setEmojiOpen(false);
      setGifOpen(false);
      setAttachment(null);
      try {
        await loadThread(next);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [loadThread],
  );

  // Live polling while a conversation is open.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void loadThread(target).catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [target, loadThread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, groupThread.length, target]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await action();
        await refresh(true);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  async function addFriend(event: FormEvent) {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    await run("add", () => friendsApi.request(wanted));
    setName("");
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    if (groupMembers.length === 0) return;
    setBusy("group");
    try {
      const group = await friendsApi.createGroup(groupName, groupMembers);
      setGroupName("");
      setGroupMembers([]);
      setGroupForm(false);
      await refresh(true);
      await openGroup(group);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function leaveGroup(group: GroupView) {
    try {
      await friendsApi.leaveGroup(group.id);
      if (target?.kind === "group" && target.id === group.id) setTarget(null);
      await refresh(true);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    const text = attachment ?? draft.trim();
    if (!text) return;
    setSending(true);
    try {
      if (target.kind === "friend") {
        await friendsApi.send(target.uuid, text);
      } else {
        await friendsApi.groupSend(target.id, text);
      }
      setDraft("");
      setAttachment(null);
      setGifOpen(false);
      await loadThread(target);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  // Tell the other side that somebody is typing — at most every three seconds.
  function announceTyping(value: string) {
    setDraft(value);
    if (!target || !value.trim()) return;
    const now = Date.now();
    if (now - typingSentAt.current < 3_000) return;
    typingSentAt.current = now;
    const call =
      target.kind === "friend"
        ? friendsApi.typing(target.uuid)
        : friendsApi.groupTyping(target.id);
    void call.catch(() => {
      /* typing is cosmetic; ignore offline errors */
    });
  }

  function handleMediaFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT) {
      setError("Das GIF ist zu groß (maximal 4 MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachment(String(reader.result ?? ""));
      setGifOpen(false);
      setError(null);
    };
    reader.onerror = () => setError("Die Datei konnte nicht gelesen werden.");
    reader.readAsDataURL(file);
  }

  async function saveEdit() {
    if (!editing || !target) return;
    const text = editing.body.trim();
    if (!text) return;
    try {
      if (target.kind === "friend") {
        await friendsApi.edit(target.uuid, editing.id, text);
      } else {
        await friendsApi.groupEdit(editing.id, text);
      }
      setEditing(null);
      await loadThread(target);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function deleteMessage(message: ChatMessage) {
    if (!target) return;
    try {
      if (target.kind === "friend") {
        await friendsApi.delete(target.uuid, message.id);
      } else {
        await friendsApi.groupDelete(message.id);
      }
      setEditing((current) => (current?.id === message.id ? null : current));
      await loadThread(target);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function changeStatus(status: FriendStatus) {
    setPresence(status);
    try {
      await friendsApi.setStatus(status);
      await refresh(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const friends = snapshot?.friends ?? [];
  const groups = snapshot?.groups ?? [];
  const incoming = snapshot?.incoming ?? [];
  const activeFriend =
    target?.kind === "friend"
      ? (friends.find((friend) => friend.uuid === target.uuid) ?? null)
      : null;
  const activeGroup =
    target?.kind === "group"
      ? (groups.find((group) => group.id === target.id) ?? null)
      : null;
  const messages = target?.kind === "group" ? groupThread : thread;

  return (
    <section className="friends">
      <header className="friends__head">
        <div>
          <h1 className="friends__title">Freunde</h1>
          <p className="friends__sub">
            {snapshot
              ? `${snapshot.me.name} · ${snapshot.server.replace(/^https?:\/\//, "")}`
              : "Verbindung zum Freundes-Server…"}
          </p>
        </div>
        <div className="friends__head-tools">
          <Segmented<FriendStatus>
            ariaLabel="Eigener Status"
            value={presence}
            options={[
              { value: "online", label: "Online" },
              { value: "away", label: "Abwesend" },
              { value: "offline", label: "Offline" },
            ]}
            onChange={(value) => void changeStatus(value)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={() => void refresh()}
          >
            Aktualisieren
          </Button>
        </div>
      </header>

      {error ? (
        <div className="friends__banner" role="alert">
          {error}
        </div>
      ) : null}

      <form className="friends__add" onSubmit={addFriend}>
        <UserPlus size={16} />
        <input
          className="friends__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Minecraft-Name, z. B. DoctoCapybara"
          maxLength={16}
          spellCheck={false}
          aria-label="Spielername"
        />
        <Button variant="primary" size="sm" type="submit" loading={busy === "add"} disabled={!name.trim()}>
          Anfrage senden
        </Button>
      </form>

      <div className={target ? "friends__grid" : "friends__grid friends__grid--solo"}>
        <div className="friends__panel">
          {incoming.length > 0 ? (
            <>
              <h2>Offene Anfragen</h2>
              <ul className="friends__list">
                {incoming.map((friend) => (
                  <li key={friend.uuid} className="friends__item">
                    <span className="friends__dot friends__dot--online" />
                    <span className="friends__name">{friend.name}</span>
                    <button
                      type="button"
                      className="friends__icon-btn friends__icon-btn--ok"
                      title={`${friend.name} annehmen`}
                      aria-label={`${friend.name} annehmen`}
                      disabled={busy === friend.uuid}
                      onClick={() => void run(friend.uuid, () => friendsApi.accept(friend.uuid))}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="friends__icon-btn friends__icon-btn--no"
                      title={`${friend.name} ablehnen`}
                      aria-label={`${friend.name} ablehnen`}
                      disabled={busy === friend.uuid}
                      onClick={() => void run(friend.uuid, () => friendsApi.remove(friend.uuid))}
                    >
                      <X size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h2>Meine Freunde</h2>
          {friends.length === 0 ? (
            <p className="friends__empty">
              Noch niemand hier. Schick oben eine Anfrage mit dem Minecraft-Namen – der andere
              Spieler bestätigt sie im Freunde-Tab, dann könnt ihr direkt schreiben.
            </p>
          ) : (
            <ul className="friends__list">
              {friends.map((friend) => (
                <li
                  key={friend.uuid}
                  className={`friends__item${
                    target?.kind === "friend" && target.uuid === friend.uuid
                      ? " friends__item--active"
                      : ""
                  }`}
                >
                  <button type="button" className="friends__row" onClick={() => void openChat(friend.uuid)}>
                    <span className={`friends__dot friends__dot--${friend.status}`} />
                    <span className="friends__name">{friend.name}</span>
                    {friend.unread > 0 ? <span className="friends__badge">{friend.unread}</span> : null}
                    <span className="friends__status">{statusText(friend)}</span>
                    <MessageSquare size={15} />
                  </button>
                  <button
                    type="button"
                    className="friends__icon-btn friends__icon-btn--no"
                    title={`${friend.name} entfernen`}
                    aria-label={`${friend.name} entfernen`}
                    disabled={busy === `remove:${friend.uuid}`}
                    onClick={() =>
                      void run(`remove:${friend.uuid}`, async () => {
                        await friendsApi.remove(friend.uuid);
                        if (target?.kind === "friend" && target.uuid === friend.uuid) setTarget(null);
                      })
                    }
                  >
                    <UserMinus size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="friends__group-head">
            <h2>Gruppen</h2>
            <button
              type="button"
              className="friends__icon-btn"
              title="Neue Gruppe"
              aria-label="Neue Gruppe"
              onClick={() => setGroupForm((open) => !open)}
            >
              <Plus size={15} />
            </button>
          </div>

          {groupForm ? (
            <form className="friends__group-form" onSubmit={createGroup}>
              <input
                className="friends__input"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Gruppenname (optional)"
                maxLength={32}
                aria-label="Gruppenname"
              />
              <div className="friends__chips">
                {friends.map((friend) => (
                  <button
                    type="button"
                    key={friend.uuid}
                    className={`friends__chip${
                      groupMembers.includes(friend.uuid) ? " friends__chip--on" : ""
                    }`}
                    onClick={() =>
                      setGroupMembers((current) =>
                        current.includes(friend.uuid)
                          ? current.filter((uuid) => uuid !== friend.uuid)
                          : [...current, friend.uuid],
                      )
                    }
                  >
                    {groupMembers.includes(friend.uuid) ? <Check size={12} /> : null}
                    {friend.name}
                  </button>
                ))}
              </div>
              <div className="friends__group-actions">
                <Button
                  variant="primary"
                  size="sm"
                  type="submit"
                  loading={busy === "group"}
                  disabled={groupMembers.length === 0}
                >
                  Gruppe erstellen
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setGroupForm(false);
                    setGroupMembers([]);
                    setGroupName("");
                  }}
                >
                  Abbrechen
                </Button>
              </div>
            </form>
          ) : null}

          {groups.length === 0 ? (
            <p className="friends__empty">
              Noch keine Gruppe. Mit dem Plus oben legst du einen Gruppenchat mit mehreren
              Freunden an.
            </p>
          ) : (
            <ul className="friends__list">
              {groups.map((group) => (
                <li
                  key={group.id}
                  className={`friends__item${
                    target?.kind === "group" && target.id === group.id
                      ? " friends__item--active"
                      : ""
                  }`}
                >
                  <button type="button" className="friends__row" onClick={() => void openGroup(group)}>
                    <span className="friends__group-icon">
                      <Users size={14} />
                    </span>
                    <span className="friends__name">{group.name}</span>
                    {group.unread > 0 ? <span className="friends__badge">{group.unread}</span> : null}
                    <span className="friends__status friends__group-preview">
                      {group.last
                        ? `${group.last.fromName ?? "?"}: ${group.last.body}`
                        : `${group.memberCount} Mitglieder`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="friends__icon-btn friends__icon-btn--no"
                    title={`${group.name} verlassen`}
                    aria-label={`${group.name} verlassen`}
                    onClick={() => void leaveGroup(group)}
                  >
                    <LogOut size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {target && (activeFriend || activeGroup) ? (
          <div className="friends__panel friends__panel--chat">
            <header className="friends__chat-head">
              {activeFriend ? (
                <span className={`friends__dot friends__dot--${activeFriend.status}`} />
              ) : (
                <span className="friends__group-icon">
                  <Users size={14} />
                </span>
              )}
              <strong>{activeFriend?.name ?? activeGroup?.name}</strong>
              <span className={`friends__status${typing || groupTyping.length > 0 ? " friends__status--typing" : ""}`}>
                {activeFriend
                  ? typing
                    ? "schreibt …"
                    : statusText(activeFriend)
                  : groupTyping.length > 0
                    ? `${groupTyping.join(", ")} schreibt …`
                    : `${activeGroup?.memberCount ?? 0} Mitglieder`}
              </span>
              <button
                type="button"
                className="friends__icon-btn"
                aria-label="Chat schließen"
                onClick={() => setTarget(null)}
              >
                <X size={15} />
              </button>
            </header>

            <div className="friends__messages">
              {messages.length === 0 ? (
                <p className="friends__empty">Noch keine Nachrichten – schreib die erste.</p>
              ) : (
                messages.map((message) => {
                  const mine = snapshot?.me.uuid === message.from;
                  const media = isMedia(message);
                  const isEditing = editing?.id === message.id;
                  return (
                    <div
                      key={message.id}
                      className={`friends__bubble${mine ? " friends__bubble--mine" : ""}`}
                    >
                      {!mine ? (
                        <span className="friends__bubble-name">
                          {message.fromName ?? activeFriend?.name ?? "?"}
                        </span>
                      ) : null}

                      {isEditing ? (
                        <div className="friends__edit">
                          <textarea
                            className="friends__input friends__edit-input"
                            value={editing.body}
                            maxLength={500}
                            onChange={(event) =>
                              setEditing({ id: message.id, body: event.target.value })
                            }
                            aria-label="Nachricht bearbeiten"
                          />
                          <div className="friends__edit-actions">
                            <Button variant="primary" size="sm" onClick={() => void saveEdit()}>
                              Speichern
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                              Abbrechen
                            </Button>
                          </div>
                        </div>
                      ) : media ? (
                        <img
                          className="friends__gif"
                          src={message.body.trim()}
                          alt={message.kind === "gif" ? "GIF" : "Bild"}
                          loading="lazy"
                        />
                      ) : (
                        <span className="friends__text">{message.body}</span>
                      )}

                      <span className="friends__meta">
                        <time>{formatTime(message.sentAt)}</time>
                        {message.edited ? <em>bearbeitet</em> : null}
                      </span>

                      {mine && !isEditing && message.kind !== "gif" && !message.body.startsWith("data:") ? (
                        <span className="friends__bubble-actions">
                          <button
                            type="button"
                            className="friends__icon-btn"
                            title="Bearbeiten"
                            aria-label="Nachricht bearbeiten"
                            onClick={() => setEditing({ id: message.id, body: message.body })}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="friends__icon-btn friends__icon-btn--no"
                            title="Löschen"
                            aria-label="Nachricht löschen"
                            onClick={() => void deleteMessage(message)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      ) : null}

                      {mine && !isEditing && (message.kind === "gif" || message.body.startsWith("data:")) ? (
                        <span className="friends__bubble-actions">
                          <button
                            type="button"
                            className="friends__icon-btn friends__icon-btn--no"
                            title="Löschen"
                            aria-label="Nachricht löschen"
                            onClick={() => void deleteMessage(message)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      ) : null}
                    </div>
                  );
                })
              )}
              {typing && activeFriend ? (
                <span className="friends__typing">schreibt …</span>
              ) : null}
              <div ref={endRef} />
            </div>

            {emojiOpen ? (
              <div className="friends__emoji-picker" role="dialog" aria-label="Emojis">
                {EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="friends__emoji"
                    onClick={() => announceTyping(draft + emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}

            {gifOpen ? (
              <div className="friends__gif-form">
                <form
                  className="friends__gif-url"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const url = gifUrl.trim();
                    if (!url) return;
                    setDraft(url);
                    setGifUrl("");
                    setGifOpen(false);
                  }}
                >
                  <input
                    className="friends__input"
                    value={gifUrl}
                    onChange={(event) => setGifUrl(event.target.value)}
                    placeholder="GIF-Link einfügen (https://…/fun.gif)"
                    aria-label="GIF-Link"
                    spellCheck={false}
                  />
                  <Button variant="secondary" size="sm" type="submit" disabled={!gifUrl.trim()}>
                    Einfügen
                  </Button>
                </form>
                <button
                  type="button"
                  className="btn btn--sm btn--secondary friends__gif-upload"
                  onClick={() => fileRef.current?.click()}
                >
                  <Film size={14} /> GIF oder Bild vom PC (max. 4 MB)
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/gif,image/png,image/jpeg,image/webp"
                  hidden
                  onChange={handleMediaFile}
                />
              </div>
            ) : null}

            {attachment ? (
              <div className="friends__attachment">
                <img src={attachment} alt="Anhang" />
                <span>Anhang bereit</span>
                <button
                  type="button"
                  className="friends__icon-btn friends__icon-btn--no"
                  aria-label="Anhang entfernen"
                  onClick={() => setAttachment(null)}
                >
                  <X size={13} />
                </button>
              </div>
            ) : null}

            <form className="friends__compose" onSubmit={sendMessage}>
              <button
                type="button"
                className={`friends__compose-btn${emojiOpen ? " friends__compose-btn--on" : ""}`}
                title="Emoji"
                aria-label="Emoji einfügen"
                onClick={() => {
                  setEmojiOpen((open) => !open);
                  setGifOpen(false);
                }}
              >
                <Smile size={16} />
              </button>
              <button
                type="button"
                className={`friends__compose-btn${gifOpen ? " friends__compose-btn--on" : ""}`}
                title="GIF senden"
                aria-label="GIF senden"
                onClick={() => {
                  setGifOpen((open) => !open);
                  setEmojiOpen(false);
                }}
              >
                <Film size={16} />
              </button>
              <input
                className="friends__input"
                value={attachment ? "" : draft}
                onChange={(event) => announceTyping(event.target.value)}
                placeholder={
                  attachment
                    ? "Anhang wird gesendet …"
                    : `Nachricht an ${activeFriend?.name ?? activeGroup?.name ?? ""}`
                }
                maxLength={500}
                aria-label="Nachricht"
                readOnly={Boolean(attachment)}
              />
              <Button
                variant="primary"
                size="sm"
                type="submit"
                icon={<Send size={14} />}
                loading={sending}
                disabled={!draft.trim() && !attachment}
              >
                Senden
              </Button>
            </form>
          </div>
        ) : null}
      </div>
    </section>
  );
}
