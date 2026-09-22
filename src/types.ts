/**
 * Wire and settings types for the Salt <-> elizaOS bridge. Mirrors the shapes
 * documented in salt-deploy's build-lanes contract (socket mode, K2) and the
 * webhook body shapes salt-api's Message/CardInteraction/ChatOpened jobs
 * serialize -- deliberately duplicated here (not imported from salt-agent-sdk)
 * because the SDK's webhook.ts types are Express-request-shaped and this
 * plugin never runs an Express server in socket mode.
 */

export type SaltDeliveryMode = "socket" | "webhook";

/** Open rooms (salt-api 0.8x): what this identity wants delivered from a
 *  plain chat it isn't necessarily @mentioned in every message of --
 *  "addressed" (only a direct reply/@mention, the closest analogue to how
 *  an encrypted chat already gates delivery -- the default, and the one
 *  mode that never calls client.setChatSubscription at all), "keywords"
 *  (any message containing one of SALT_SUBSCRIPTION_KEYWORDS), or "all"
 *  (every message). See client.setChatSubscription in salt-agent-sdk. */
export type SaltSubscriptionMode = "addressed" | "keywords" | "all";

/** Resolved plugin configuration, read from character/runtime settings (see config.ts). */
export interface SaltPluginConfig {
  host: string;
  appId: string;
  apiKey: string;
  publicKey: string;
  privateKey: string;
  passphrase: string;
  mode: SaltDeliveryMode;
  webhookPort: number;
  webhookPublicUrl?: string;
  pollTimeoutSeconds: number;
  pollLimit: number;
  verifySignatures: boolean;
  autoReply: boolean;
  askHumanTimeoutSeconds: number;
  /** Directory the resume cursor and delivery-id dedupe set are persisted in
   *  (salt-agent-sdk's FileCursorStore/FileDedupeStore -- see service.ts). */
  stateDir: string;
  /** Open rooms: this identity's own subscription preference, applied via
   *  client.setChatSubscription whenever it's newly added to a plain chat
   *  (see service.ts's handleChatOpenedEnvelope). Undefined means "never
   *  call setChatSubscription" -- the same effective behavior as
   *  "addressed", just without the extra API call. */
  subscriptionMode?: SaltSubscriptionMode;
  /** Keywords this identity follows when subscriptionMode is "keywords". */
  subscriptionKeywords: string[];
}

/** One row from GET /api/v1/agent/updates. `headers` carries the exact
 *  X-Salt-* headers the equivalent webhook POST would have carried
 *  (including X-Salt-Signature, computed the same way); `body` is the exact
 *  JSON body string. */
export interface SaltUpdateEnvelope {
  id: number | string;
  delivery_id: string;
  event: SaltEventName;
  headers: Record<string, string>;
  body: string;
  created_at: string;
}

export type SaltEventName =
  | "message"
  | "chat_opened"
  | "card_interaction"
  | "billing"
  | "handoff"
  | "call"
  | string;

export interface SaltUpdatesResponse {
  updates: SaltUpdateEnvelope[];
  cursor: number | string;
}

/** salt-api's Chat allowlist on a message webhook (WebhookJob#user_send). */
export interface SaltChatMeta {
  id: string;
  name?: string | null;
  public?: boolean;
  managed?: boolean;
  open_invite?: boolean;
  mode?: "auto" | "manual";
  active_agent_id?: string;
  mediator_agent_id?: string;
  coaching_for_chat_id?: string;
  private_lane?: boolean;
  lane_kind?: string;
  /** Open rooms (salt-api 0.8x): false marks a plain chat with no
   *  end-to-end encryption -- see README.md's "Open rooms" section.
   *  Absent (or true) is an ordinary encrypted chat. */
  encrypted?: boolean;
}

export interface SaltMessageUser {
  id: string;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  system?: boolean;
  avatar_url?: string | null;
}

/** The `message` half of a "message" event body (Message#formatted_message). */
export interface SaltFormattedMessage {
  chat_id: string;
  message: string;
  sender_message?: string | null;
  message_id: string | number;
  seq?: number | null;
  message_type: string;
  version: number;
  event_type?: string | null;
  reply_to_message_id?: string | number | null;
  user: SaltMessageUser;
  created_at: string;
  resource_type?: string;
  resource_id?: string;
  resource?: Record<string, unknown>;
  reactions?: unknown[];
  delegations?: Array<{ agent_id: string; chat_id: string; username: string }>;
  coaching_for_chat_id?: string;
  quiet?: boolean;
  /** Open rooms: false means `message` is plain text, not a PGP blob --
   *  see SaltChatMeta.encrypted and README.md's "Open rooms" section. */
  encrypted?: boolean;
  /** Interests: why this open-room message was delivered to this identity
   *  (see client.setChatSubscription's `mode`). Absent for an ordinary
   *  encrypted chat, and absent until salt-api's open-rooms rollout starts
   *  sending it on the wire -- not yet in salt-agent-sdk 0.10.0's own typed
   *  MessageContext as of this writing, so this is read defensively. */
  delivered_because?: "mention" | "reply" | "keyword" | "all" | string;
  deleted_at?: string | null;
  deleted_by?: unknown;
  locked_at?: string | null;
  locked_by?: unknown;
  can_delete_for_everyone?: boolean;
}

export interface SaltMessageEventBody {
  chat: SaltChatMeta;
  message: SaltFormattedMessage;
}

export interface SaltCardInteractionEventBody {
  type: "card_interaction";
  card_id: string;
  owner_id: string;
  chat_id: string;
  action_id: string;
  value: string;
  state: unknown;
  user: { id: string; username: string; display_name: string; account_type: "User" | "Agent" };
}

export interface SaltChatOpenedMember {
  id: string;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  public_key?: string;
  observer?: boolean;
}

export interface SaltChatOpenedEventBody {
  type: "chat_opened";
  chat: SaltChatMeta;
  opened_by: SaltChatOpenedMember;
  members: SaltChatOpenedMember[];
  opened_at: string;
}

/** What the SALT_CHAT_CONTEXT provider surfaces, kept per elizaOS roomId. */
export interface SaltChatContextEntry {
  saltChatId: string;
  chatName?: string | null;
  isGroup: boolean;
  members: Array<{ id: string; username: string; displayName: string; accountType: "User" | "Agent"; publicKey?: string }>;
  /** Money requests this identity has observed live in this chat since it started (not backfilled). */
  pendingRequests: Array<{ resourceId: string; amount?: unknown; status?: string; note?: string }>;
  updatedAt: number;
}

/** A card this identity posted with SALT_ASK_HUMAN, awaiting exactly one tap. */
export interface PendingCardWait {
  resolve: (result: SaltCardTapResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SaltCardTapResult {
  actionId: string;
  value: string;
  userDisplayName: string;
  userId: string;
}
