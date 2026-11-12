import { describe, expect, it } from "vitest";

import { send, tokenOf } from "../support/http.js";
import { API_SERVICES, routeCases, tokenSpecFor } from "../support/table.js";

describe("every prefix of the routing table reaches its backend", () => {
  it.each(routeCases)("$label: $method $path -> $backend (class $cls)", async (c) => {
    const spec = tokenSpecFor(c.cls);
    const token = spec ? tokenOf(spec) : undefined;
    const reply = await send({ method: c.method, path: c.path, token });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe(c.backend);
    // The path is forwarded unchanged (no prefix is stripped or added).
    expect(reply.seen.path).toBe(c.path);
    if (token) {
      // Each service checks the token again, so the gateway must pass the Authorization header on.
      expect(reply.seen.headers["authorization"]).toBe(`Bearer ${token}`);
    }
  });
});

describe("precedence between rules of one service", () => {
  it("the share-link lookup is public for POST on that exact path and for nothing else below /v1/shared-markets", async () => {
    const open = await send({ method: "POST", path: "/v1/shared-markets/lookup" });
    expect(open.status).toBe(200);
    expect(open.backend).toBe("markets");
    // A bearer token is passed on when there is one, so markets can tell a member from a stranger.
    const token = tokenOf({ groups: ["/trader"] });
    const withToken = await send({ method: "POST", path: "/v1/shared-markets/lookup", token });
    expect(withToken.status).toBe(200);
    expect(withToken.seen.headers["authorization"]).toBe(`Bearer ${token}`);
    for (const [method, path] of [
      ["GET", "/v1/shared-markets/lookup"],
      ["POST", "/v1/shared-markets/lookup/extra"],
      ["POST", "/v1/shared-markets"],
      ["POST", "/v1/shared-markets/other"],
    ] as const) {
      const reply = await send({ method, path });
      expect(reply.backend, `${method} ${path}`).not.toBe("markets");
    }
  });

  it("POST and GET on /v1/markets need only a valid token: the market role is checked by markets", async () => {
    const trader = tokenOf({ groups: ["/trader"] });
    expect((await send({ method: "GET", path: "/v1/markets", token: trader })).status).toBe(200);
    expect((await send({ method: "POST", path: "/v1/markets", token: trader })).status).toBe(200);
    expect((await send({ method: "POST", path: "/v1/markets" })).status).toBe(401);
  });

  it("an exact path beats the prefix: /v1/tenants is for platform-admin, /v1/tenants/{id}/... for any valid token", async () => {
    const tenantAdmin = tokenOf({ groups: ["/tenant-admin"] });
    const platformAdmin = tokenOf({ roles: ["platform-admin"] });
    expect((await send({ path: "/v1/tenants", token: tenantAdmin })).status).toBe(403);
    expect((await send({ path: "/v1/tenants", token: platformAdmin })).status).toBe(200);
    expect((await send({ path: "/v1/tenants/acme/members", token: platformAdmin })).status).toBe(200);
    expect((await send({ path: "/v1/tenants/acme/members", token: tenantAdmin })).status).toBe(200);
  });

  it("the trailing slash of the tenant list does not open it to a tenant-admin", async () => {
    const tenantAdmin = tokenOf({ groups: ["/tenant-admin"] });
    expect((await send({ path: "/v1/tenants/", token: tenantAdmin })).status).toBe(403);
    expect((await send({ path: "/v1/tenants//", token: tenantAdmin })).status).toBe(403);
    expect((await send({ path: "/v1/tenants/", token: tokenOf({ roles: ["platform-admin"] }) })).status).toBe(200);
  });

  it("the provider's webhook is public only for POST on that exact path", async () => {
    expect((await send({ method: "POST", path: "/v1/webhooks/payment-provider" })).status).toBe(200);
    expect((await send({ method: "GET", path: "/v1/webhooks/payment-provider" })).status).toBe(401);
    expect((await send({ method: "POST", path: "/v1/webhooks/payment-provider/extra" })).status).toBe(401);
    expect((await send({ method: "POST", path: "/v1/webhooks/other" })).status).toBe(401);
  });

  it("the public webhook does not look at a token the provider never sends", async () => {
    const reply = await send({ method: "POST", path: "/v1/webhooks/payment-provider", token: "not-a-token" });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe("payments");
  });
});

describe("paths that only look like a prefix of the table", () => {
  it.each([
    "/v1/marketsx",
    "/v1/tradingx/orders",
    "/v1/tenantsx",
    "/v1/mex",
    "/v1/unknown",
    "/checkoutx",
    "/realms/chancex/x",
    "/resourcesx",
  ])("%s reaches no API service", async (path) => {
    const reply = await send({ path, token: tokenOf({ roles: ["platform-admin", "tenant-admin", "trader"] }) });
    expect(API_SERVICES).not.toContain(reply.backend);
    expect(reply.backend === "web" || reply.backend === null).toBe(true);
  });
});

describe("the host name is part of every rule", () => {
  it("another Host header matches no route", async () => {
    const reply = await send({ path: "/v1/me", token: tokenOf({ groups: ["/trader"] }), host: "other.example" });
    expect(reply.status).toBe(404);
    expect(reply.backend).toBeNull();
  });
});
