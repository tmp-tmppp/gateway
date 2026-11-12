import type { TokenSpec } from "./tokens.js";

/** The route classes of the chart (helm/values.yaml): what a request needs to pass the gateway. */
export type RouteClass = "public" | "static" | "web" | "user" | "trading" | "platform-admin";

export interface RouteCase {
  label: string;
  method: string;
  /** A concrete path under the prefix, as a client would send it. */
  path: string;
  cls: RouteClass;
  /** The Service that has to answer. */
  backend: string;
}

/** The services that own a /v1 API; the web UI and the login pages are not among them. */
export const API_SERVICES = ["markets", "trading", "market-data", "tenants", "payments", "audit"];

/** Request headers that name a caller. The gateway never sets them (oauth2-proxy answers only 202, 401 or 403 and no
 * header is copied from its answer), so a client must not be able to supply them either: the `strip-identity`
 * Middleware deletes them first on every route. Written by hand, as the oracle of the tests. */
export const IDENTITY_HEADERS = [
  "X-Auth-Request-User",
  "X-Auth-Request-Email",
  "X-Auth-Request-Groups",
  "X-Auth-Request-Preferred-Username",
  "X-Auth-Request-Access-Token",
  "X-Forwarded-User",
  "X-Forwarded-Email",
  "X-Forwarded-Groups",
  "X-Forwarded-Preferred-Username",
  "X-Forwarded-Access-Token",
];

/** The plan's routing table (section 6) with one request per prefix and per class. Written by hand: the e2e tests'
 * oracle. The drift test ties the chart and the local routes to each other, these cases tie the local routes to the plan. */
export const routeCases: RouteCase[] = [
  { label: "markets list", method: "GET", path: "/v1/markets", cls: "user", backend: "markets" },
  { label: "markets one", method: "GET", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001", cls: "user", backend: "markets" },
  { label: "markets create", method: "POST", path: "/v1/markets", cls: "user", backend: "markets" },
  { label: "markets open", method: "POST", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/open", cls: "user", backend: "markets" },
  { label: "markets close", method: "POST", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/close", cls: "user", backend: "markets" },
  { label: "markets resolve", method: "POST", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/resolve", cls: "user", backend: "markets" },
  { label: "share links make", method: "POST", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/share-links", cls: "user", backend: "markets" },
  { label: "share links list", method: "GET", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/share-links", cls: "user", backend: "markets" },
  { label: "share link revoke", method: "DELETE", path: "/v1/markets/0d4b1c1e-0000-4000-8000-000000000001/share-links/0d4b1c1e-0000-4000-8000-000000000002", cls: "user", backend: "markets" },
  { label: "shared market lookup", method: "POST", path: "/v1/shared-markets/lookup", cls: "public", backend: "markets" },
  { label: "trading", method: "POST", path: "/v1/trading/orders", cls: "trading", backend: "trading" },
  { label: "market data", method: "GET", path: "/v1/market-data/prices", cls: "user", backend: "market-data" },
  { label: "tenants create", method: "POST", path: "/v1/tenants", cls: "platform-admin", backend: "tenants" },
  { label: "tenants list", method: "GET", path: "/v1/tenants", cls: "platform-admin", backend: "tenants" },
  { label: "tenant invites", method: "POST", path: "/v1/tenants/acme/invites", cls: "user", backend: "tenants" },
  { label: "tenant members", method: "GET", path: "/v1/tenants/acme/members", cls: "user", backend: "tenants" },
  { label: "member role", method: "PUT", path: "/v1/tenants/acme/members/u-1/role", cls: "user", backend: "tenants" },
  { label: "me", method: "GET", path: "/v1/me", cls: "user", backend: "tenants" },
  { label: "my organizations", method: "GET", path: "/v1/me/organizations", cls: "user", backend: "tenants" },
  { label: "share join", method: "POST", path: "/v1/share-joins", cls: "user", backend: "tenants" },
  { label: "invite accept", method: "POST", path: "/v1/invites/ABCD-EFGH/accept", cls: "user", backend: "tenants" },
  { label: "deposits", method: "POST", path: "/v1/deposits", cls: "user", backend: "payments" },
  { label: "withdrawals", method: "GET", path: "/v1/withdrawals/w-1", cls: "user", backend: "payments" },
  { label: "webhooks (other than the provider's)", method: "POST", path: "/v1/webhooks/other", cls: "user", backend: "payments" },
  { label: "provider webhook", method: "POST", path: "/v1/webhooks/payment-provider", cls: "public", backend: "payments" },
  { label: "audit", method: "GET", path: "/v1/audit", cls: "user", backend: "audit" },
  { label: "audit verify", method: "GET", path: "/v1/audit/verify", cls: "user", backend: "audit" },
  { label: "checkout page", method: "GET", path: "/checkout/sessions/s-1", cls: "public", backend: "payment-provider" },
  { label: "checkout root", method: "GET", path: "/checkout", cls: "public", backend: "payment-provider" },
  { label: "login page", method: "GET", path: "/realms/chance/protocol/openid-connect/auth", cls: "public", backend: "identity" },
  { label: "realm discovery", method: "GET", path: "/realms/chance/.well-known/openid-configuration", cls: "public", backend: "identity" },
  { label: "login resources", method: "GET", path: "/resources/abc/login/keycloak/css/styles.css", cls: "static", backend: "identity" },
  { label: "web UI root", method: "GET", path: "/", cls: "web", backend: "web" },
  { label: "web UI asset", method: "GET", path: "/assets/app.js", cls: "web", backend: "web" },
];

/** The cheapest token that is enough for a class. */
export function tokenSpecFor(cls: RouteClass): TokenSpec | undefined {
  switch (cls) {
    case "platform-admin":
      return { roles: ["platform-admin"] };
    case "user":
    case "trading":
      return { groups: ["/trader"] };
    default:
      return undefined;
  }
}

export const protectedCases = routeCases.filter((c) => !["public", "static", "web"].includes(c.cls));
