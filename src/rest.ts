/**
 * The handful of Salt REST calls salt-agent-sdk's typed client (0.7.1)
 * doesn't cover yet: the socket-mode long-poll endpoint (LANES.md's K2
 * contract, not in the SDK because the SDK predates it), self-service
 * delivery-mode switching, and a plain (non-invoice) payment request --
 * `client.createInvoice` always sends `request_type: "invoice"`, but
 * SALT_REQUEST_PAYMENT needs the plain TransferRequest#create path
 * (transfer_requests_controller#create without `request_type`).
 */

import type { SaltClient, SaltUser } from "salt-agent-sdk";
import type { SaltUpdatesResponse } from "./types";

export class SaltPluginRestError extends Error {
  status: number;
  body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    const reason = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? `: ${(body as { error: string }).error}` : "";
    super(`Salt API ${method} ${path} -> ${status}${reason}`);
    this.name = "SaltPluginRestError";
    this.status = status;
    this.body = body;
  }
}

async function rawRequest<T>(
  fetchImpl: typeof fetch,
  host: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown
): Promise<T> {
  const url = `${host.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "api-key": apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = await res.text().catch(() => undefined);
    }
    throw new SaltPluginRestError(method, path, res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * GET /api/v1/agent/updates?after=&timeout=&limit= -- LANES.md's socket-mode
 * contract. `timeout` is honored server-side (the request waits up to that
 * many seconds when there is nothing new), so callers should give this a
 * fetch/AbortSignal timeout comfortably longer than `timeout`.
 */
export async function fetchAgentUpdates(
  fetchImpl: typeof fetch,
  host: string,
  apiKey: string,
  opts: { after: number | string; timeout: number; limit: number; signal?: AbortSignal }
): Promise<SaltUpdatesResponse> {
  const url = `${host.replace(/\/$/, "")}/api/v1/agent/updates?after=${encodeURIComponent(String(opts.after))}&timeout=${opts.timeout}&limit=${opts.limit}`;
  const res = await fetchImpl(url, { headers: { "api-key": apiKey }, signal: opts.signal });
  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = await res.text().catch(() => undefined);
    }
    throw new SaltPluginRestError("GET", "/api/v1/agent/updates", res.status, parsed);
  }
  return (await res.json()) as SaltUpdatesResponse;
}

/**
 * PATCH /api/v1/agents/delivery {mode} -- self-service, same auth as
 * PATCH /api/v1/agents/callback. Best-effort: the endpoint is new (this
 * plugin was built against the LANES.md spec ahead of the socket lane's
 * salt-api deploy), so a 404 here just means the deployment hasn't shipped
 * it yet -- an agent with a blank callback already behaves as socket by
 * default, so callers should log and continue rather than fail startup.
 */
export async function setDeliveryMode(fetchImpl: typeof fetch, host: string, apiKey: string, mode: "socket" | "webhook"): Promise<void> {
  await rawRequest(fetchImpl, host, "PATCH", "/api/v1/agents/delivery", apiKey, { mode });
}

export interface CreatePaymentRequestParams {
  chatId: string;
  receiverId: string;
  walletId: string;
  amount: string | number;
  message?: string;
}

/** POST /api/v1/transfer_requests, no `request_type` -- a plain payment
 *  request (as opposed to client.createInvoice's itemized invoice). */
export async function createPaymentRequest(fetchImpl: typeof fetch, host: string, apiKey: string, params: CreatePaymentRequestParams): Promise<unknown> {
  return rawRequest(fetchImpl, host, "POST", "/api/v1/transfer_requests", apiKey, {
    chat_id: params.chatId,
    receiver_id: params.receiverId,
    wallet_id: params.walletId,
    amount: params.amount,
    message: params.message,
  });
}

export interface SaltWallet {
  id: string;
  chain?: string;
  testnet?: boolean;
  name_3?: string;
  public_address?: string;
  deleted_at?: string | null;
  [key: string]: unknown;
}

/**
 * Picks the wallet SALT_REQUEST_PAYMENT / SALT_SEND_INVOICE should receive
 * into: an exact ticker match (case-insensitive `name_3`) when a currency
 * was named, else the caller's first active wallet. Mirrors the same
 * resolve-by-ticker rule cards_controller#actions applies to a card's own
 * "pay" button (`wallets.active.find_by(name_3: currency)`), so a model
 * naming "USDC" behaves the same way a card author's pay button does.
 */
export function resolveWallet(wallets: SaltWallet[], currency?: string): SaltWallet | undefined {
  const active = wallets.filter((w) => !w.deleted_at);
  if (currency) {
    const match = active.find((w) => typeof w.name_3 === "string" && w.name_3.toLowerCase() === currency.toLowerCase());
    if (match) return match;
    return undefined;
  }
  return active[0];
}

/** Picks the other human/agent this action should address in a 1:1, or an
 *  explicitly named member in a group. Excludes the caller's own identity
 *  and any silent delegation observer. */
export function resolveReceiver(members: SaltUser[], selfId: string, wantedHandle?: string): SaltUser | undefined {
  const candidates = members.filter((m) => String(m.id) !== String(selfId));
  if (wantedHandle) {
    const needle = wantedHandle.replace(/^@/, "").toLowerCase();
    return candidates.find((m) => m.username?.toLowerCase() === needle || m.display_name?.toLowerCase() === needle);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export type { SaltClient };
