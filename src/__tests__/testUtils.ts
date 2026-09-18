/**
 * A minimal fake IAgentRuntime covering only what this plugin's Service and
 * actions actually call. Cast through `unknown` rather than implementing the
 * real (very large) interface -- standard for a plugin unit-testing its own
 * narrow use of the runtime, not the runtime itself.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { vi } from "vitest";

export interface FakeRuntime {
  agentId: string;
  ensureConnection: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  getService: ReturnType<typeof vi.fn>;
  useModel: ReturnType<typeof vi.fn>;
  getSetting: ReturnType<typeof vi.fn>;
  messageService: { handleMessage: ReturnType<typeof vi.fn> } | null;
}

export function createFakeRuntime(overrides: Partial<FakeRuntime> = {}): { runtime: IAgentRuntime; fake: FakeRuntime } {
  const fake: FakeRuntime = {
    agentId: "agent-runtime-id",
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    getRoom: vi.fn().mockResolvedValue(null),
    getService: vi.fn().mockReturnValue(null),
    useModel: vi.fn().mockResolvedValue(""),
    getSetting: vi.fn().mockReturnValue(undefined),
    messageService: { handleMessage: vi.fn().mockResolvedValue({ didRespond: false, responseMessages: [] }) },
    ...overrides,
  };
  return { runtime: fake as unknown as IAgentRuntime, fake };
}
