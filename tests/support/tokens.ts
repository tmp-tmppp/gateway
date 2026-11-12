import { createHmac, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const ISSUER = "https://chance.example/realms/chance";
export const AUDIENCE = "chance";
export const KID = "e2e-key";

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** A throwaway RSA key pair: the private key signs the test tokens, the public key is served as the JWKS. */
export function makeKeyPair(): { privateKeyPem: string; jwks: { keys: Record<string, unknown>[] } } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    jwks: { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] },
  };
}

export interface TokenSpec {
  /** Realm roles, the claim realm_access.roles (only platform-admin means anything at the gateway). */
  roles?: string[];
  /** Groups of the one organization, the claim organization.acme.groups ("/trader", "/tenant-admin"): token contract v2.
   * The gateway does not read them; the services do. */
  groups?: string[];
  /** Leave realm_access out, like a token of a service account without roles. */
  noRealmAccess?: boolean;
  iss?: string;
  aud?: string | string[];
  /** Seconds until expiry; negative = already expired. */
  expiresIn?: number;
  /** Sign with this key instead of the identity provider's. */
  key?: KeyObject;
  alg?: "RS256" | "none" | "HS256";
}

/** Builds a signer for tokens of the identity provider whose private key is given (PEM). */
export function makeSigner(privateKeyPem: string): (spec?: TokenSpec) => string {
  const signingKey = createPrivateKey(privateKeyPem);
  return (spec: TokenSpec = {}): string => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: spec.iss ?? ISSUER,
      aud: spec.aud ?? AUDIENCE,
      sub: "11111111-2222-4333-8444-555555555555",
      iat: now,
      exp: now + (spec.expiresIn ?? 300),
      organization: { acme: { groups: spec.groups ?? [] } },
    };
    if (!spec.noRealmAccess) {
      claims["realm_access"] = { roles: spec.roles ?? [] };
    }
    const alg = spec.alg ?? "RS256";
    const head = b64(JSON.stringify({ alg, typ: "JWT", kid: KID }));
    const body = b64(JSON.stringify(claims));
    const input = `${head}.${body}`;
    if (alg === "none") {
      return `${input}.`;
    }
    if (alg === "HS256") {
      return `${input}.${createHmac("sha256", "not-the-identity-provider-key").update(input).digest("base64url")}`;
    }
    return `${input}.${b64(sign("sha256", Buffer.from(input), spec.key ?? signingKey))}`;
  };
}
