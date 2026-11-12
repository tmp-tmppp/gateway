import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUDIENCE, ISSUER, makeKeyPair } from "./tokens.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COMPOSE_FILE = join(root, "local", "compose.yaml");
export const RUN_DIR = join(root, ".run");
export const PROJECT = "gateway-e2e";

/** The containers of the proof, named in local/compose.yaml. Whatever is left of them is removed by name. */
export const CONTAINERS = [
  "gw-e2e-traefik",
  "gw-e2e-oauth2-proxy",
  "gw-e2e-idp",
  "gw-e2e-markets",
  "gw-e2e-trading",
  "gw-e2e-market-data",
  "gw-e2e-tenants",
  "gw-e2e-payments",
  "gw-e2e-audit",
  "gw-e2e-payment-provider",
  "gw-e2e-identity",
  "gw-e2e-web",
];

export interface StackInfo {
  baseUrl: string;
  host: string;
  privateKeyPem: string;
}

function docker(args: string[], env: NodeJS.ProcessEnv): { status: number; out: string } {
  const run = spawnSync("docker", args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

function compose(args: string[], env: NodeJS.ProcessEnv): { status: number; out: string } {
  return docker(["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], env);
}

/** Starts the stack with fresh keys and secrets for this run. Returns what the tests need. */
export function up(): StackInfo {
  const { privateKeyPem, jwks } = makeKeyPair();
  const idpDir = join(RUN_DIR, "idp");
  rmSync(idpDir, { recursive: true, force: true });
  const realm = join(idpDir, "realms", "chance");
  mkdirSync(join(realm, "protocol", "openid-connect"), { recursive: true, mode: 0o755 });
  writeFileSync(join(realm, "protocol", "openid-connect", "certs"), JSON.stringify(jwks), { mode: 0o644 });
  const discovery = {
    issuer: ISSUER,
    jwks_uri: "http://idp:8080/realms/chance/protocol/openid-connect/certs",
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: "http://idp:8080/realms/chance/protocol/openid-connect/token",
    id_token_signing_alg_values_supported: ["RS256"],
    subject_types_supported: ["public"],
    response_types_supported: ["code"],
    audience: AUDIENCE,
  };
  mkdirSync(join(realm, ".well-known"), { recursive: true, mode: 0o755 });
  writeFileSync(join(realm, ".well-known", "openid-configuration"), JSON.stringify(discovery), { mode: 0o644 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_E2E_IDP_DIR: idpDir,
    OAUTH2_PROXY_CLIENT_SECRET: randomBytes(16).toString("hex"),
    OAUTH2_PROXY_COOKIE_SECRET: randomBytes(16).toString("hex"),
  };
  // A run that was killed may have left containers behind.
  compose(["down", "-v", "--remove-orphans"], env);
  const started = compose(["up", "-d"], env);
  if (started.status !== 0) {
    throw new Error(`docker compose up failed:\n${started.out}`);
  }
  const port = compose(["port", "traefik", "8000"], env).out.trim().split(":").pop();
  if (!port || !/^\d+$/.test(port)) {
    throw new Error("cannot read the published port of Traefik");
  }
  return { baseUrl: `http://127.0.0.1:${port}`, host: "chance.example", privateKeyPem };
}

/** Saves the logs of the containers under .run/logs, removes the stack and checks that nothing is left. */
export function down(): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_E2E_IDP_DIR: join(RUN_DIR, "idp"),
    OAUTH2_PROXY_CLIENT_SECRET: "unused",
    OAUTH2_PROXY_COOKIE_SECRET: "unused",
  };
  mkdirSync(join(RUN_DIR, "logs"), { recursive: true });
  writeFileSync(join(RUN_DIR, "logs", "compose.log"), compose(["logs", "--no-color"], env).out);
  compose(["down", "-v", "--remove-orphans"], env);
  const left = docker(["ps", "-a", "--filter", "name=gw-e2e-", "--format", "{{.Names}}"], env)
    .out.split("\n")
    .filter(Boolean);
  if (left.length > 0) {
    docker(["rm", "-f", ...left], env);
  }
  rmSync(join(RUN_DIR, "idp"), { recursive: true, force: true });
}
