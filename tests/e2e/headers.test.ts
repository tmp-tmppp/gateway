import { describe, expect, it } from "vitest";

import { send, tokenOf } from "../support/http.js";
import { IDENTITY_HEADERS, protectedCases, routeCases, tokenSpecFor } from "../support/table.js";

const NO_STORE = "private, no-store";

describe("Cache-Control: private, no-store (INF-02)", () => {
  // The static login files and the web UI are cacheable on purpose: they carry no tenant data.
  const withHeader = routeCases.filter((c) => !["static", "web"].includes(c.cls));

  it.each(withHeader)("a $cls response: $method $path", async (c) => {
    const spec = tokenSpecFor(c.cls);
    const reply = await send({ method: c.method, path: c.path, token: spec ? tokenOf(spec) : undefined });
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe(NO_STORE);
  });

  it.each(protectedCases)("the 401 of $method $path carries it", async (c) => {
    const reply = await send({ method: c.method, path: c.path });
    expect(reply.status).toBe(401);
    expect(reply.headers["cache-control"]).toBe(NO_STORE);
  });

  it("the 403 of a wrong role carries it", async () => {
    const reply = await send({ path: "/v1/tenants", token: tokenOf({ groups: ["/trader"] }) });
    expect(reply.status).toBe(403);
    expect(reply.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("X-Correlation-Id passes through", () => {
  it.each(routeCases.filter((c) => !["static", "web"].includes(c.cls)))("$method $path", async (c) => {
    const spec = tokenSpecFor(c.cls);
    const reply = await send({
      method: c.method,
      path: c.path,
      token: spec ? tokenOf(spec) : undefined,
      headers: { "x-correlation-id": "0b6f2a54-3c61-4f0e-9d0c-7a1e5d2b9c10" },
    });
    expect(reply.status).toBe(200);
    expect(reply.seen.headers["x-correlation-id"]).toBe("0b6f2a54-3c61-4f0e-9d0c-7a1e5d2b9c10");
  });
});

describe("identity headers a client sends never reach a service", () => {
  // The services read the caller from the token. A header such as X-Auth-Request-User is what a service behind an
  // authenticating reverse proxy might trust, so none of them may arrive from the outside, on any route class.
  const forged = Object.fromEntries(IDENTITY_HEADERS.map((name) => [name.toLowerCase(), "admin@chance.example"]));

  it.each(routeCases)("$cls: $method $path", async (c) => {
    const spec = tokenSpecFor(c.cls);
    const reply = await send({ method: c.method, path: c.path, token: spec ? tokenOf(spec) : undefined, headers: forged });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe(c.backend);
    const leaked = IDENTITY_HEADERS.map((name) => name.toLowerCase()).filter((name) => name in reply.seen.headers);
    expect(leaked).toEqual([]);
    // The check is not vacuous: the headers that belong to the request are still there.
    expect(reply.seen.headers["x-forwarded-for"]).toBeDefined();
  });
});

describe("headers a client could use to pose as someone else", () => {
  it("a client-supplied X-Forwarded-For is not trusted (the rate limit keys on the real address)", async () => {
    const reply = await send({
      path: "/v1/me",
      token: tokenOf({ groups: ["/trader"] }),
      headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" },
    });
    expect(reply.status).toBe(200);
    expect(reply.seen.headers["x-forwarded-for"] ?? "").not.toContain("203.0.113.9");
  });

  it("headers whose names alias another header (X_Auth_User for X-Auth-User) are dropped", async () => {
    const reply = await send({
      path: "/v1/me",
      token: tokenOf({ groups: ["/trader"] }),
      headers: { "x_auth_user": "admin", "x.auth.user": "admin", "x-correlation-id": "c-1" },
    });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.seen.headers).filter((name) => /^x[_.]/.test(name))).toEqual([]);
    expect(reply.seen.headers["x-correlation-id"]).toBe("c-1");
  });

  it("identity headers a client sets are not turned into a gateway decision", async () => {
    // oauth2-proxy would trust these only with --pass-user-headers and a reverse-proxy mode this chart does not use.
    const reply = await send({
      path: "/v1/tenants",
      token: tokenOf({ groups: ["/trader"] }),
      headers: { "x-auth-request-groups": "platform-admin", "x-forwarded-groups": "platform-admin", "x-forwarded-user": "admin" },
    });
    expect(reply.status).toBe(403);
  });
});
