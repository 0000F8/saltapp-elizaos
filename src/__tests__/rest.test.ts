import { describe, expect, it, vi } from "vitest";
import { fetchAgentUpdates } from "../rest";

function fakeFetch(body: unknown = { updates: [], cursor: 0 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

describe("fetchAgentUpdates", () => {
  it("omits `after` entirely on a fresh start (cursor 0) -- round-4 contract: the server's own stored ack applies", async () => {
    const fetchImpl = fakeFetch();
    await fetchAgentUpdates(fetchImpl as unknown as typeof fetch, "https://saltapp.test", "key", {
      after: 0,
      timeout: 2,
      limit: 50,
    });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).not.toContain("after=");
    expect(url).toContain("timeout=2");
    expect(url).toContain("limit=50");
  });

  it("also omits `after` for a string \"0\" cursor", async () => {
    const fetchImpl = fakeFetch();
    await fetchAgentUpdates(fetchImpl as unknown as typeof fetch, "https://saltapp.test", "key", {
      after: "0",
      timeout: 2,
      limit: 50,
    });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).not.toContain("after=");
  });

  it("sends `after` once a real cursor exists", async () => {
    const fetchImpl = fakeFetch();
    await fetchAgentUpdates(fetchImpl as unknown as typeof fetch, "https://saltapp.test", "key", {
      after: 42,
      timeout: 2,
      limit: 50,
    });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("after=42");
  });

  it("sends the host's api-key header and no query param leaks it", async () => {
    const fetchImpl = fakeFetch();
    await fetchAgentUpdates(fetchImpl as unknown as typeof fetch, "https://saltapp.test", "secret-key", {
      after: 0,
      timeout: 2,
      limit: 50,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "api-key": "secret-key" });
    expect(url as string).not.toContain("secret-key");
  });
});
