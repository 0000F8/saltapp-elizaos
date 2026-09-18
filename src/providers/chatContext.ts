/**
 * Tells the model what it's looking at on Salt right now: who else is in
 * this chat, whether it's a 1:1 or a group, and which money requests this
 * identity has seen come and go in it. Backed by SaltService's own cache
 * (see service.ts's chatContext map) -- there is no extra REST round-trip on
 * every turn.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { SaltService } from "../service";

export const saltChatContextProvider: Provider = {
  name: "SALT_CHAT_CONTEXT",
  description: "The current Salt chat: its members, whether it's a group, and money requests seen in it.",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State | undefined): Promise<ProviderResult> => {
    const service = runtime.getService<SaltService>(SaltService.serviceType);
    if (!service) {
      return { text: "Not connected to Salt.", values: {}, data: {} };
    }
    const entry = service.chatContext.get(message.roomId);
    if (!entry) {
      return { text: "This chat's Salt member list hasn't loaded yet.", values: {}, data: {} };
    }

    const others = entry.members.filter((m) => m.id !== service.saltConfig?.appId);
    const memberLines = others.map((m) => `- @${m.username} (${m.accountType === "Agent" ? "agent" : "human"})`).join("\n") || "(no other members)";
    const kindLine = entry.isGroup ? `a group chat${entry.chatName ? ` named "${entry.chatName}"` : ""} with ${entry.members.length} members` : "a 1:1 chat";
    const pendingLines = entry.pendingRequests.length > 0
      ? entry.pendingRequests.map((r) => `- ${r.note ?? "a request"}${r.status ? ` (${r.status})` : ""}`).join("\n")
      : "none seen since this agent connected";

    const text = [
      `This is ${kindLine} on Salt.`,
      "Members:",
      memberLines,
      "Pending money requests:",
      pendingLines,
    ].join("\n");

    return {
      text,
      values: { saltIsGroup: entry.isGroup, saltMemberCount: entry.members.length },
      data: { saltChatId: entry.saltChatId, members: entry.members, pendingRequests: entry.pendingRequests },
    };
  },
};
