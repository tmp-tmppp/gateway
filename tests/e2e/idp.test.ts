import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { AUDIENCE, ISSUER, KID } from "../support/tokens.js";

// The stub identity provider is not published: ask it from inside its own container (busybox has wget).
function fromIdp(path: string): unknown {
  const run = spawnSync("docker", ["exec", "gw-e2e-idp", "wget", "-qO-", `http://127.0.0.1:8080${path}`], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

describe("the stub identity provider", () => {
  it("serves the signing key of this run's tokens at the path Keycloak uses", () => {
    const jwks = fromIdp("/realms/chance/protocol/openid-connect/certs") as { keys: { kid: string; kty: string; alg: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kid: KID, kty: "RSA", alg: "RS256" });
  });

  it("serves a discovery document with the issuer the gateway expects", () => {
    const doc = fromIdp("/realms/chance/.well-known/openid-configuration") as { issuer: string; jwks_uri: string; audience: string };
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.audience).toBe(AUDIENCE);
    expect(doc.jwks_uri).toMatch(/\/realms\/chance\/protocol\/openid-connect\/certs$/);
  });
});
