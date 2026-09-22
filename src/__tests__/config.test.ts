import { describe, expect, it } from "vitest";
import { loadSaltPluginConfig } from "../config";
import { createFakeRuntime } from "./testUtils";

function runtimeWithSettings(settings: Record<string, string>) {
  const { runtime, fake } = createFakeRuntime();
  fake.getSetting.mockImplementation((key: string) => settings[key]);
  return runtime;
}

describe("loadSaltPluginConfig", () => {
  it("defaults pollTimeoutSeconds to 2 -- round-4 socket contract clamps the server side to 0..2", () => {
    const config = loadSaltPluginConfig(runtimeWithSettings({}));
    expect(config.pollTimeoutSeconds).toBe(2);
  });

  it("clamps an explicit SALT_POLL_TIMEOUT_SECONDS above 2 down to 2 rather than sending a stale 25s expectation", () => {
    const config = loadSaltPluginConfig(runtimeWithSettings({ SALT_POLL_TIMEOUT_SECONDS: "25" }));
    expect(config.pollTimeoutSeconds).toBe(2);
  });

  it("defaults stateDir under process.cwd()/data/salt/<appId>, namespaced per identity", () => {
    const config = loadSaltPluginConfig(runtimeWithSettings({ SALT_APP_ID: "agent-xyz" }));
    expect(config.stateDir).toContain("data");
    expect(config.stateDir).toContain("salt");
    expect(config.stateDir).toContain("agent-xyz");
  });

  it("honors an explicit SALT_STATE_DIR override", () => {
    const config = loadSaltPluginConfig(runtimeWithSettings({ SALT_STATE_DIR: "/custom/salt-state" }));
    expect(config.stateDir).toBe("/custom/salt-state");
  });
});
