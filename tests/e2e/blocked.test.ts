import { describe, expect, it } from "vitest";

import { send, tokenOf } from "../support/http.js";
import { API_SERVICES } from "../support/table.js";

const tokens: [string, () => string | undefined][] = [
  ["no token", () => undefined],
  ["trader", () => tokenOf({ groups: ["/trader"] })],
  ["tenant-admin", () => tokenOf({ groups: ["/tenant-admin"] })],
  ["platform-admin", () => tokenOf({ roles: ["platform-admin"] })],
];

describe("/v1/internal is never routed", () => {
  // The last one is markets' admission check for tenants (service token): it must stay unreachable from outside.
  const paths = ["/v1/internal", "/v1/internal/", "/v1/internal/events", "/v1/internal/events?x=1", "/v1/internal/share-links/admission"];
  for (const [who, token] of tokens) {
    for (const method of ["GET", "POST", "DELETE"]) {
      it.each(paths)(`${who}: ${method} %s answers 403 and no backend sees it`, async (path) => {
        const reply = await send({ method, path, token: token() });
        expect(reply.status).toBe(403);
        expect(reply.backend).toBeNull();
        expect(reply.headers["cache-control"]).toBe("private, no-store");
      });
    }
  }
});

describe("the Keycloak admin console and the master realm are not routed", () => {
  it.each(["/admin", "/admin/", "/admin/master/console/", "/realms/master", "/realms/master/protocol/openid-connect/token"])(
    "%s answers 403 and identity does not see it",
    async (path) => {
      const reply = await send({ path });
      expect(reply.status).toBe(403);
      expect(reply.backend).toBeNull();
    },
  );

  it("the realm paths a browser needs stay public", async () => {
    for (const path of ["/realms/chance/protocol/openid-connect/auth", "/resources/x/y.css"]) {
      const reply = await send({ path });
      expect(reply.status, path).toBe(200);
      expect(reply.backend, path).toBe("identity");
    }
  });
});

describe("encoded characters in the path are refused (helm/traefik-values.yaml, ports.web.http.encodedCharacters)", () => {
  it.each([
    ["encoded slash", "/v1/trading/..%2finternal"],
    ["encoded slash, upper case", "/v1/markets%2F..%2Finternal"],
    ["encoded backslash", "/v1/trading/..%5cinternal"],
    ["encoded null", "/v1/me%00"],
    ["encoded semicolon", "/v1/me%3bx=1"],
    ["encoded percent", "/v1/%252e%252e/internal"],
    ["encoded question mark", "/v1/me%3fx=1"],
    ["encoded hash", "/v1/me%23x"],
  ])("%s: %s answers 400 and no backend sees it", async (_title, path) => {
    const reply = await send({ path, token: tokenOf({ roles: ["platform-admin", "tenant-admin", "trader"] }) });
    expect(reply.status).toBe(400);
    expect(reply.backend).toBeNull();
  });
});

describe("spellings of the blocked paths never reach a service", () => {
  // Whatever answers (the deny rule, the web catch-all or Traefik itself), it is not a service that owns a /v1 API,
  // and never the identity service for the master realm.
  const internal = [
    "/v1//internal",
    "//v1/internal",
    "/v1/./internal",
    "/v1/%69nternal",
    "/v1/%49nternal",
    "/v1/internal%2fevents",
    "/v1/internal%00",
    "/v1/internal;x=1",
    "/v1/internal.",
    "/V1/internal",
    "/v1/trading/../internal",
    "/v1/trading/%2e%2e/internal",
    "/v1/trading/..%2finternal",
    "/v1/markets/../internal/events",
  ];
  it.each(internal)("%s", async (path) => {
    const reply = await send({ path, token: tokenOf({ roles: ["platform-admin", "tenant-admin", "trader"] }) });
    expect(API_SERVICES).not.toContain(reply.backend);
    // Denied (403), refused (400) or sent to the web UI as an unknown path; never to a service.
    expect([null, "web"]).toContain(reply.backend);
  });

  const admin = [
    "//admin",
    "/./admin",
    "/%61dmin",
    "/admin%2f",
    "/realms/chance/../master/protocol/openid-connect/token",
    "/realms/chance/%2e%2e/master/protocol/openid-connect/token",
    "/realms/chance/..%2fmaster/protocol/openid-connect/token",
    "/realms/%6dmaster",
    "/resources/../admin/master/console/",
  ];
  it.each(admin)("%s", async (path) => {
    const reply = await send({ path });
    // Identity answers only the paths of the chance realm and /resources, whatever the spelling.
    expect([null, "web"]).toContain(reply.backend);
  });
});
