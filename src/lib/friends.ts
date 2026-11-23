/** Typed bridge for the friends commands (`src-tauri/src/commands/friends.rs`). */

import { invoke } from "./bridge";

export type FriendStatus = "online" | "ingame" | "away" | "offline";

export interface FriendView {
  uuid: string;
  name: string;
  /** `online`, `ingame`, `away` or `offline`. */
  status: string;
  detail: string | null;
  lastSeen: string | null;
  unread: number;
  /** Set while the friend is writing in the open conversation. */
  typing: boolean;
}

export interface ChatMessage {
  id: number;
  from: string;
  fromName: string | null;
  body: string;
  /** `text`, `image` or `gif`; media bodies are data URLs. */
  kind: string;
  sentAt: string;
  /** Text was changed after sending. */
  edited: boolean;
}

export interface GroupMember {
  uuid: string;
  name: string;
  status: string;
}

export interface GroupPreview {
  id: number;
  from: string;
  fromName: string | null;
  body: string;
  kind: string;
  sentAt: string;
  edited: boolean;
}

export interface GroupView {
  id: number;
  name: string;
  owner: string;
  members: GroupMember[];
  memberCount: number;
  unread: number;
  last: GroupPreview | null;
}

export interface GroupThread {
  messages: ChatMessage[];
  last: number;
  /** Names of members writing right now. */
  typing: string[];
}

export interface FriendsSnapshot {
  me: FriendView;
  friends: FriendView[];
  incoming: FriendView[];
  outgoing: FriendView[];
  unread: Record<string, number>;
  groups: GroupView[];
  /** Server the launcher talks to (shown in the UI). */
  server: string;
}

export interface FriendsThread {
  messages: ChatMessage[];
  last: number;
  /** The other side is typing right now. */
  typing: boolean;
}

export const friendsApi = {
  overview: () => invoke<FriendsSnapshot>("friends_overview"),
  request: (name: string) => invoke<void>("friends_request", { name }),
  accept: (uuid: string) => invoke<void>("friends_accept", { uuid }),
  remove: (uuid: string) => invoke<void>("friends_remove", { uuid }),
  send: (uuid: string, body: string) => invoke<void>("friends_send", { uuid, body }),
  messages: (uuid: string, since: number) =>
    invoke<FriendsThread>("friends_messages", { uuid, since }),
  /** Announces that the player is writing (throttled by the caller). */
  typing: (uuid: string) => invoke<void>("friends_typing", { uuid }),
  edit: (uuid: string, id: number, body: string) =>
    invoke<void>("friends_edit", { uuid, id, body }),
  delete: (uuid: string, id: number) => invoke<void>("friends_delete", { uuid, id }),
  /** `online`, `away` or `offline`; remembered for the next start. */
  setStatus: (status: string) => invoke<void>("friends_set_status", { status }),

  // --- Groups ----------------------------------------------------------
  groups: () => invoke<GroupView[]>("friends_groups"),
  createGroup: (name: string, members: string[]) =>
    invoke<GroupView>("friends_group_create", {
      name: name.trim() ? name.trim() : null,
      members,
    }),
  leaveGroup: (id: number) => invoke<void>("friends_group_leave", { id }),
  groupMessages: (id: number, since: number) =>
    invoke<GroupThread>("friends_group_messages", { id, since }),
  groupSend: (id: number, body: string) =>
    invoke<void>("friends_group_send", { id, body }),
  groupTyping: (id: number) => invoke<void>("friends_group_typing", { id }),
  groupEdit: (messageId: number, body: string) =>
    invoke<void>("friends_group_edit", { id: messageId, body }),
  groupDelete: (messageId: number) =>
    invoke<void>("friends_group_delete", { id: messageId }),
};
