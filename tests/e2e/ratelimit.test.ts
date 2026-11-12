import { describe, expect, it } from "vitest";

import { send, sleep, tokenOf } from "../support/http.js";
import type { Reply } from "../support/http.js";

// RateLimit per client address (helm/values.yaml, "rateLimit"): trading 10 per second with a burst of 20 (requirement
// 23), the other API routes 50 per second with a burst of 100. The tests wait for the buckets to refill before and after.
const BURST = 100;

async function burst(path: string, method: string): Promise<Reply[]> {
  const token = tokenOf({ groups: ["/trader"] });
  return Promise.all(Array.from({ length: BURST }, () => send({ method, path, token, unpaced: true })));
}

describe("rate limits", () => {
  it("a burst on /v1/trading gets 429, and the 429 carries the no-store header", async () => {
    await sleep(3000);
    const replies = await burst("/v1/trading/orders", "POST");
    const limited = replies.filter((r) => r.status === 429);
    const served = replies.filter((r) => r.status === 200);
    expect(limited.length).toBeGreaterThanOrEqual(20);
    // The burst of 20 plus what refills while the requests run.
    expect(served.length).toBeGreaterThanOrEqual(15);
    expect(served.length).toBeLessThan(BURST);
    for (const r of limited) {
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.backend).toBeNull();
    }
    await sleep(3000);
  });

  it("the same burst on another API route (burst 100) is not limited", async () => {
    await sleep(3000);
    const replies = await burst("/v1/market-data/prices", "GET");
    expect(replies.filter((r) => r.status === 429)).toHaveLength(0);
    expect(replies.every((r) => r.status === 200 && r.backend === "market-data")).toBe(true);
  });

  it("the public share-link lookup has the public limit (burst 60): a flood gets 429 with the no-store header", async () => {
    await sleep(3000);
    const replies = await Promise.all(
      Array.from({ length: BURST }, () => send({ method: "POST", path: "/v1/shared-markets/lookup", unpaced: true })),
    );
    const limited = replies.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(10);
    expect(replies.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(40);
    for (const r of limited) {
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.backend).toBeNull();
    }
    await sleep(3000);
  });

  it("the limit refills: trading answers again after a pause", async () => {
    await sleep(3000);
    const reply = await send({ method: "POST", path: "/v1/trading/orders", token: tokenOf({ groups: ["/trader"] }), unpaced: true });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe("trading");
  });
});
