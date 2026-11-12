// Removes what the end-to-end run may have left: the Compose project "gateway-e2e" (containers, network) and, by name,
// every container of the proof. Safe to run any time: "npm run stack:down".
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Compose interpolates the required variables even for "down"; the values do not matter here.
const env = {
  ...process.env,
  GATEWAY_E2E_IDP_DIR: join(here, "..", ".run", "idp"),
  OAUTH2_PROXY_CLIENT_SECRET: "unused",
  OAUTH2_PROXY_COOKIE_SECRET: "unused",
};
const down = spawnSync("docker", ["compose", "-p", "gateway-e2e", "-f", join(here, "compose.yaml"), "down", "-v", "--remove-orphans"], {
  env,
  stdio: "inherit",
});
const left = spawnSync("docker", ["ps", "-a", "--filter", "name=gw-e2e-", "--format", "{{.Names}}"], { env, encoding: "utf8" });
const names = left.stdout.split("\n").filter(Boolean);
if (names.length > 0) {
  spawnSync("docker", ["rm", "-f", ...names], { env, stdio: "inherit" });
}
process.stdout.write(`${names.length > 0 ? `removed leftovers: ${names.join(", ")}` : "no containers left"}\n`);
process.exit(down.status ?? 1);
