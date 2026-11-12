import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { send, tokenOf } from "../support/http.js";
import type { Call } from "../support/http.js";
import { protectedCases, routeCases } from "../support/table.js";
import type { RouteClass } from "../support/table.js";

const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

/** One protected route per class: enough for the token checks, which do not depend on the path. */
const samples: { cls: RouteClass; method: string; path: string }[] = [
  { cls: "user", method: "GET", path: "/v1/me" },
  { cls: "trading", method: "POST", path: "/v1/trading/orders" },
  { cls: "platform-admin", method: "GET", path: "/v1/tenants" },
];

describe("no token", () => {
  it.each(protectedCases)("$label: $method $path answers 401 without reaching $backend", async (c) => {
    const reply = await send({ method: c.method, path: c.path });
    expect(reply.status).toBe(401);
    expect(reply.backend).toBeNull();
  });
});

describe("a valid token of the wrong role answers 403", () => {
  const wrong: [string, RouteClass, string[]][] = [
    ["trader on a platform-admin route", "platform-admin", ["trader"]],
    ["tenant-admin on a platform-admin route", "platform-admin", ["tenant-admin", "trader"]],
    ["no role at all on a platform-admin route", "platform-admin", []],
  ];
  for (const [title, cls, roles] of wrong) {
    describe(title, () => {
      it.each(protectedCases.filter((c) => c.cls === cls))("$label: $method $path", async (c) => {
        const reply = await send({ method: c.method, path: c.path, token: tokenOf({ roles }) });
        expect(reply.status).toBe(403);
        expect(reply.backend).toBeNull();
      });
    });
  }

  it("a role name must match exactly", async () => {
    for (const role of ["Platform-Admin", "platform-admin-x", "xplatform-admin", "platform_admin"]) {
      const reply = await send({ path: "/v1/tenants", token: tokenOf({ roles: [role] }) });
      expect(reply.status, role).toBe(403);
    }
  });

  it("a group of the organization named platform-admin is no realm role: the platform-admin class refuses it", async () => {
    for (const groups of [["/platform-admin"], ["platform-admin"]]) {
      expect((await send({ path: "/v1/tenants", token: tokenOf({ groups }) })).status).toBe(403);
    }
  });

  it("a token without realm_access (a service token) passes the user classes and not the platform-admin class", async () => {
    const token = tokenOf({ noRealmAccess: true });
    expect((await send({ path: "/v1/me", token })).status).toBe(200);
    expect((await send({ method: "POST", path: "/v1/trading/orders", token })).status).toBe(200);
    expect((await send({ path: "/v1/tenants", token })).status).toBe(403);
  });

  // Token contract v2: the tenant role is a group of the organization, a claim path that contains the alias, which
  // oauth2-proxy cannot read. The gateway checks the token only; the services refuse a caller without the role.
  it("tenant-role routes (audit, members, invites, market lifecycle) need a valid token and no role at the edge", async () => {
    const tenantRoutes = [
      { method: "GET", path: "/v1/audit" },
      { method: "GET", path: "/v1/tenants/acme/members" },
      { method: "POST", path: "/v1/tenants/acme/invites" },
      { method: "POST", path: "/v1/markets" },
      { method: "POST", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/open" },
    ];
    for (const route of tenantRoutes) {
      expect((await send({ ...route })).status, `${route.path} without a token`).toBe(401);
      for (const token of [tokenOf({ groups: ["/tenant-admin"] }), tokenOf({ groups: ["/trader"] }), tokenOf({ noRealmAccess: true })]) {
        expect((await send({ ...route, token })).status, route.path).toBe(200);
      }
    }
  });

  it("a user route accepts any role set, including none", async () => {
    for (const roles of [[], ["trader"], ["something-else"], ["platform-admin"]]) {
      expect((await send({ path: "/v1/me", token: tokenOf({ roles }) })).status).toBe(200);
    }
  });
});

describe("a token the gateway does not accept answers 401", () => {
  const forged: [string, () => Call["token"], Call["headers"]?][] = [
    ["another issuer", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], iss: "https://evil.example/realms/chance" })],
    ["another audience", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], aud: "account" })],
    ["audience list without chance", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], aud: ["account", "payments"] })],
    ["expired", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], expiresIn: -60 })],
    ["signed with another key", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], key: otherKey })],
    ["alg none", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], alg: "none" })],
    ["HS256", () => tokenOf({ roles: ["tenant-admin", "platform-admin"], alg: "HS256" })],
    ["garbage", () => "garbage"],
    ["empty bearer", () => ""],
  ];
  for (const s of samples) {
    describe(`class ${s.cls}: ${s.method} ${s.path}`, () => {
      it.each(forged)("%s", async (_title, token) => {
        const reply = await send({ method: s.method, path: s.path, token: token() });
        expect(reply.status).toBe(401);
        expect(reply.backend).toBeNull();
      });

      it("Basic credentials instead of a bearer token", async () => {
        const reply = await send({ method: s.method, path: s.path, headers: { authorization: "Basic dXNlcjpwYXNz" } });
        expect(reply.status).toBe(401);
      });

      it("a valid token in the query string is not a bearer token", async () => {
        const token = tokenOf({ roles: ["tenant-admin", "platform-admin", "trader"] });
        const reply = await send({ method: s.method, path: `${s.path}?access_token=${token}` });
        expect(reply.status).toBe(401);
        expect(reply.backend).toBeNull();
      });
    });
  }
});

describe("tokens as Keycloak issues them", () => {
  it("an audience list that contains chance is accepted", async () => {
    const reply = await send({ path: "/v1/me", token: tokenOf({ groups: ["/trader"], aud: ["account", "chance"] }) });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe("tenants");
  });
});

describe("public routes do not ask for a token", () => {
  it.each(routeCases.filter((c) => ["public", "static", "web"].includes(c.cls)))("$label: $method $path", async (c) => {
    const reply = await send({ method: c.method, path: c.path });
    expect(reply.status).toBe(200);
    expect(reply.backend).toBe(c.backend);
  });
});
