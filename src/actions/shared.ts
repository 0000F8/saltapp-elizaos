/**
 * Common lookups every SALT_* action needs: the running SaltService and the
 * Salt chat id behind the elizaOS room the current turn is in. `Room.channelId`
 * is the raw external id `ensureConnection` was given (service.ts), so this
 * is the one place an action recovers the Salt chat_id from a message's
 * (hashed) `roomId` -- see plugin-matrix's identical use of `channelId` for
 * the same reason.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { SaltUser } from "salt-agent-sdk";
import { SaltService, SALT_SOURCE } from "../service";

export interface SaltActionRoom {
  service: SaltService;
  saltChatId: string;
}

export async function resolveSaltRoom(runtime: IAgentRuntime, message: Memory): Promise<SaltActionRoom | null> {
  const service = runtime.getService<SaltService>(SaltService.serviceType);
  if (!service) return null;
  const room = await runtime.getRoom(message.roomId);
  if (!room || room.source !== SALT_SOURCE || !room.channelId) return null;
  return { service, saltChatId: room.channelId };
}

/** Members of the current chat, refreshed straight from Salt (not the
 *  provider's cache) -- money actions need a live, current member/key list. */
export async function loadChatMembers(actionRoom: SaltActionRoom): Promise<SaltUser[]> {
  return actionRoom.service.client.getChatMembers(actionRoom.service.saltConfig.apiKey, actionRoom.saltChatId);
}

export function isSaltActionValidatable(room: SaltActionRoom | null): room is SaltActionRoom {
  return room !== null;
}
