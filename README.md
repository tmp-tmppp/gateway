# gateway

The API gateway of **Chance**: the single public entry point of the cluster. It terminates TLS, checks the bearer
token and the coarse role of each route, rate-limits, and routes by path prefix to the services. This is a
configuration repository (Helm values and templates), not a service: there is no code to build, and the checks run on
the rendered manifests. Decision record: ADR-034 (Traefik through the Gateway API, JWT checks by ForwardAuth;
status Proposed, used as the working default).

## Parts

| Part | What | Where |
|---|---|---|
| Traefik Proxy v3 | The proxy and the only pod with a public address. Reads Gateway API and Traefik CRDs. | Official Traefik chart, values in [`helm/traefik-values.yaml`](helm/traefik-values.yaml); namespace `gateway` |
| GatewayClass `traefik` | Created by the Traefik chart | Traefik chart |
| Gateway API CRDs | v1.6.3, Standard channel: Gateway, HTTPRoute, ReferenceGrant and the other kinds, plus the admission policy `safe-upgrades` | Release file of kubernetes-sigs/gateway-api, applied by the pipeline (cluster-wide) |
| cert-manager | Issues the certificate (Let's Encrypt HTTP-01 through the Gateway) | Official chart, values in [`helm/cert-manager-values.yaml`](helm/cert-manager-values.yaml); namespace `cert-manager` |
| Gateway | One Gateway, an `http` and an `https` listener, hostname from a value | [`helm/templates/gateway.yaml`](helm/templates/gateway.yaml) |
| HTTPRoutes | One per service, prefix matches, one filter per rule: the middleware chain of the rule's class | [`helm/templates/httproutes.yaml`](helm/templates/httproutes.yaml), table in [`helm/values.yaml`](helm/values.yaml) |
| Middlewares | Response headers, rate limits, token checks, deny-all, and one chain per route class | [`helm/templates/middlewares.yaml`](helm/templates/middlewares.yaml) |
| oauth2-proxy | Target of the ForwardAuth middlewares: validates the bearer JWT and the role | [`helm/templates/oauth2-proxy.yaml`](helm/templates/oauth2-proxy.yaml) |
| TLS objects | cert-manager Issuer (Let's Encrypt HTTP-01 through the Gateway, or self-signed) and Certificate | [`helm/templates/certificate.yaml`](helm/templates/certificate.yaml) |
| ReferenceGrant | Lets the routes in `gateway` name Services in the services' namespace, one Service at a time | [`helm/templates/referencegrant.yaml`](helm/templates/referencegrant.yaml) |
| NetworkPolicy | Off by default: admits only Traefik to oauth2-proxy | [`helm/templates/networkpolicy.yaml`](helm/templates/networkpolicy.yaml) |
| Smoke test | `helm test`: oauth2-proxy answers and refuses a request without a token; Traefik answers | [`helm/templates/tests/smoke-test.yaml`](helm/templates/tests/smoke-test.yaml) |

```
browser / provider
      |  https
      v
Traefik (namespace gateway)  --ForwardAuth, only for token routes-->  oauth2-proxy  (JWKS of the identity provider)
      |  HTTPRoute -> Middleware chain -> backend
      v
markets, trading, market-data, tenants, payments, audit, payment-provider, identity, web   (namespace prod)
```

State: none. Everything is declared in the chart; the two secrets of oauth2-proxy are in the Secret `gateway-env`,
and the certificate in the Secret `gateway-tls`.

## Metrics

Traefik serves its own Prometheus metrics (`traefik_*`: entry points, services, process), not the `http_requests_total`
family of the Node services, so the services' convention (names and labels) does not apply to it; only the port and the
way Prometheus finds it do (REQ-20). The settings are in `helm/traefik-values.yaml`:

- **Port.** The entry point `metrics` on container port 9464 (`ports.metrics.port`, the Traefik chart's default is 9100),
  path `/metrics`. It is neither `web` nor `websecure`, and `ports.metrics.expose.default: false` keeps it out of the
  LoadBalancer Service, so the public address never carries it and the routes of the Gateway never reach it. The
  scrapes are kept out of the access log and out of the entry-point request counters
  (`ports.metrics.observability`).
- **Discovery.** The Traefik chart (42.3.1, `templates/_podtemplate.tpl`) puts `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` on the Traefik Pods itself, from `ports.metrics.port`
  and `metrics.prometheus.entryPoint`; so `deployment.podAnnotations` stays empty (a second set would repeat the keys).
  The Prometheus of the `observability` chart keeps every Pod with those annotations and scrapes the Pod address.
- **NetworkPolicy.** This chart's NetworkPolicy selects only the oauth2-proxy Pods, and the Traefik chart has none, so
  nothing blocks the scrape of the Traefik Pods and no rule was added. A policy that selects the Traefik Pods would deny
  everything it does not list, public traffic included; if one is added, it has to list the entry points `web` and
  `websecure` (any source) and the `monitoring` namespace on 9464.
- **Check.** `kubectl -n gateway port-forward deploy/traefik 9464` and `curl -s localhost:9464/metrics | head`. Not run:
  there is no cluster here. The rendered chart was compared with the one before (annotation port, entry-point address,
  container port and the two observability flags changed; the Service still lists 80 and 443 only).

## Routes

The plan's routing table (section 6), with what the gateway checks. Each service checks the token and the role
again; the gateway is the coarse first line: that a token is valid and, for two routes, that it carries the realm role
`platform-admin`. It does not check a tenant role (token contract v2, ADR-059): the tenant role is a group of the one
organization in the token (`organization.<alias>.groups`), a claim path that contains the alias, which oauth2-proxy
cannot read, so tenants, markets, payments and audit enforce `tenant-admin` and `trader` themselves.
Rules are written in [`helm/values.yaml`](helm/values.yaml) under `routes`.
When two matches fit, the more specific wins (an exact path, then the longer prefix, then a match with a method).

| Path | Method | Backend | Class | Who gets through |
|---|---|---|---|---|
| `/v1/tenants` (exact) | any | tenants | `platform-admin` | create and list tenants: role `platform-admin` |
| `/v1/tenants/...` | any | tenants | `user` | invites, members, roles of a tenant: any valid token (tenants checks `tenant-admin`) |
| `/v1/me`, `/v1/me/organizations`, `/v1/invites/...`, `/v1/share-joins` | any | tenants | `user` | any valid token; no organization needed (accepting an invite or a share link is how a user gets one) |
| `/v1/shared-markets/lookup` (exact) | `POST` | markets | `public` | nobody needs a token (a bearer token is passed on when there is one); the public rate limit applies; the link's token is in the body |
| `/v1/markets` and below | any | markets | `user` | any valid token (markets checks `trader` / `tenant-admin` and refuses a platform admin), also the share links of a market |
| `/v1/trading/...` | any | trading | `trading` | any valid token, stricter rate limit |
| `/v1/market-data/...` | any | market-data | `user` | any valid token |
| `/v1/deposits/...`, `/v1/withdrawals/...` | any | payments | `user` | any valid token |
| `/v1/webhooks/payment-provider` (exact) | `POST` | payments | `public` | nobody needs a token; payments checks the provider's signature |
| `/v1/webhooks/...` (other) | any | payments | `user` | any valid token |
| `/v1/audit/...` | any | audit | `user` | any valid token (audit checks `tenant-admin`) |
| `/checkout/...` | any | payment-provider | `public` | the payment pages of the mock provider |
| `/realms/chance/...` | any | identity | `public` | login, registration and token endpoints for browsers |
| `/resources/...` | any | identity | `static` | static files of the login pages |
| `/v1/internal/...`, `/admin/...`, `/realms/master/...` | any | (none) | `deny` | nobody: always 403 |
| `/` (everything else) | any | web | `web` | the web UI, public; the Service `web` is a placeholder until the UI exists |

Public: `/v1/webhooks/payment-provider`, `/checkout`, `/realms/chance`, `/resources` and the web UI. Never routed: the
Keycloak admin console and the master realm, `/oauth2/...` of oauth2-proxy, the trading Service's internal port 8081,
and the health endpoints of every service. A path that matches nothing goes to the web UI, which is why `/v1/internal`
has its own explicit rule (answers 403, never reaches a service).

## Middlewares

Building blocks: `strip-identity` (deletes the request headers that name a caller: `X-Auth-Request-` and
`X-Forwarded-` followed by `User`, `Email`, `Groups`, `Preferred-Username` and `Access-Token`; a Traefik headers
Middleware deletes a request header whose value is empty), `headers` (`Cache-Control: private, no-store`, INF-02), `rl-api`, `rl-trading`, `rl-public` (Traefik
RateLimit per client address; trading is the stricter one, REQ-23), `auth-user`,
`auth-platform-admin` (ForwardAuth to oauth2-proxy, the last one with `?allowed_groups=platform-admin`), `deny-all`
(an `ipAllowList` that admits only a reserved test address, so every request is answered 403).

One chain per class, in this order: `strip-identity` first on every chain, so no service receives an identity header
from a client (the gateway sets none itself), then the headers, so they also reach the 401, 403 and 429 answers of the
entries after them:

| Class | Chain |
|---|---|
| `public` | strip-identity, headers, rl-public |
| `static`, `web` | strip-identity, rl-public |
| `user` | strip-identity, headers, rl-api, auth-user |
| `trading` | strip-identity, headers, rl-trading, auth-user |
| `platform-admin` | strip-identity, headers, rl-api, auth-platform-admin |
| `deny` | strip-identity, headers, deny-all |

A rule attaches its chain as one `ExtensionRef` filter (`group: traefik.io`, `kind: Middleware`). Traefik reads
Middlewares through its Kubernetes CRD provider, which `traefik-values.yaml` keeps on for the namespace `gateway` only
(`providers.kubernetesCRD.namespaces`): an `IngressRoute` created in another namespace is not read, so it cannot become
a public route that skips the token, role and `/v1/internal` rules.

## The token check

oauth2-proxy runs without upstream and without a login flow; only `GET /oauth2/auth` is used. Traefik forwards the
`Authorization` header of the client request to it (plus its own `X-Forwarded-*` headers) and passes the request on
when the answer is 2xx; any other answer goes back to the client.

| Setting (env `OAUTH2_PROXY_...`) | Value | Why |
|---|---|---|
| `SKIP_JWT_BEARER_TOKENS` | `true` | the access token is validated as a bearer JWT (signature, `iss`, `aud`, `exp`) |
| `OIDC_ISSUER_URL`, `SKIP_OIDC_DISCOVERY`, `OIDC_JWKS_URL` | public issuer, discovery off, in-cluster keys URL | the token's `iss` is the public address; the keys are fetched from the identity Service inside the cluster (the services do the same) |
| `CLIENT_ID` | `chance` | the audience the realm puts into every token |
| `OIDC_GROUPS_CLAIM` | `realm_access.roles` | oauth2-proxy accepts a dotted path into the token for the groups, so the realm role `platform-admin` is its group (the roles `trader` and `tenant-admin` are organization groups since token contract v2 and are not checked here) |
| `OIDC_EMAIL_CLAIM` | `sub` | a service token has no e-mail address, and an unverified one would be refused |
| `SKIP_CLAIMS_FROM_PROFILE_URL`, `EMAIL_DOMAINS` | `true`, `*` | no user-info call; no e-mail domain filter |
| `CLIENT_SECRET`, `COOKIE_SECRET` | from the Secret `gateway-env` | required by oauth2-proxy although no login flow is used; never in values |

The per-route role is the query string of the ForwardAuth address: `/oauth2/auth?allowed_groups=platform-admin` (the only role class left). Answers:
`202` valid token with a listed role (or no role required), `401` missing or invalid token (bad signature, issuer,
audience or expiry), `403` valid token without the role.

**Checked** (2026-11-11, the pinned oauth2-proxy image with exactly the settings the chart renders, a stub key set and
tokens signed in a throwaway script, no Keycloak): 13 of 13 expectations held, among them trader token for a
role-restricted route 403, a token without `realm_access` for a route without role 202, and wrong audience, wrong
issuer, expired and garbage tokens 401 (that run used the earlier `tenant-admin` class; with token contract v2 the one
role class left is `platform-admin`, and `tests/e2e/auth.test.ts` covers it behind a real Traefik). The proof that stays in this
repository runs the same chart settings behind a real Traefik: see [Local proof](#local-proof) for the query string of
the ForwardAuth address, the rule precedence, the `deny-all` answer and the spellings of `/v1/internal`
(`tests/e2e/auth.test.ts`, `blocked.test.ts`, `routing.test.ts`).

An invalid token and a key set that cannot be fetched end the same way: oauth2-proxy logs the error, the request stays
without a session and `/oauth2/auth` answers 401 (v7.15.6, `pkg/middleware/jwt_session.go`, with the default
`bearer-token-login-fallback`). So a status code cannot tell a bad token from an unreachable identity provider; see
"Not done yet" for the NetworkPolicy that can cause the second.

## TLS

The Gateway has an `http` listener (container port 8000, the Traefik entry point `web`) and an `https` listener (8443,
`websecure`), both for the hostname value. The `https` listener terminates TLS with the Secret `gateway-tls`, which
cert-manager fills from the Certificate. The `http` listener carries one route that redirects every request to
HTTPS with a 301, and, during issuance, the temporary route of the ACME challenge; that route is an exact path, so it
wins over the redirect. Issuers (`tls.issuer.type`): `acme` (Let's Encrypt; staging by default, production in
`values-prod.yaml`), `selfSigned` (`values-dev.yaml`), `existing` (an Issuer or ClusterIssuer that already exists).
`tls.enabled: false` removes the HTTPS listener, the redirect and the certificate objects.

The public host is not known yet (plan INF-01): `hostname` is `chance.example` in the values, and the pipeline sets it at
deploy from the organization variable `PUBLIC_HOST`, the ACME contact address from the organization secret `ACME_EMAIL`
("Deploy"). The hostname
also has to resolve to the public IP of the Traefik Service before the first certificate can be issued.

## Versions

Every image is pinned by tag and digest; the charts and the CRD bundle that the pipeline installs by version and by the
sha256 of the downloaded file (`.github/workflows/ci-cd.yml`), so a moved release file or a republished chart version
stops the run.

| Part | Version | Source (read 2026-11-11) |
|---|---|---|
| Traefik Helm chart | 42.3.1 (2026-11-06), archive `sha256:984969e5...6218dcd` | `Chart.yaml` and `values.yaml` of tag `v42.3.1` in github.com/traefik/traefik-helm-chart: appVersion v3.7.17, `providers.kubernetesGateway`, `gateway.enabled`, `image.digest`; its `crds/` holds only the `traefik.io` and `hub.traefik.io` CRDs, and its README says the Gateway API CRDs are no longer shipped with the chart (read 2026-11-12) |
| Traefik Proxy | v3.7.17, `sha256:f4bb143d...a86f5a` | the chart's appVersion; Docker Hub manifest digest of `traefik:v3.7.17` |
| Gateway API CRDs | v1.6.3, Standard channel, `standard-install.yaml` `sha256:356c2b8e...eff977fe5` (10 CRDs and the ValidatingAdmissionPolicy `safe-upgrades` with its binding) | doc.traefik.io/traefik/v3.7/reference/install-configuration/providers/kubernetes/kubernetes-gateway/ ("supports Standard version v1.6.3"); v1.7.0 exists (2026-10-29) but Traefik 3.7 names 1.6.3; the v1.6.3 release has only the files `standard-install.yaml` and `experimental-install.yaml`, no chart (read 2026-11-12) |
| ExtensionRef filters | `group: traefik.io`, `kind: Middleware`; needs the CRD provider | doc.traefik.io/traefik/v3.7/reference/routing-configuration/kubernetes/gateway-api/; `loadMiddlewares` in `pkg/provider/kubernetes/gateway/httproute.go` at v3.7.17 |
| Route precedence in Traefik | exact path, then longer prefix, then method | `buildMatchRule` in the same file (exact +100000, prefix +10000 and 100 per character, method +1000) |
| ReferenceGrant | supported for cross-namespace backends | `isReferenceGranted` in the same file |
| oauth2-proxy | v7.15.6 (2026-11-05), `sha256:c3415e86...12048` | github.com/oauth2-proxy/oauth2-proxy at tag v7.15.6: `util/claim_extractor.go` (dotted claim path), `providers/oidc.go` (`CreateSessionFromToken`), `oauthproxy.go` (`AuthOnly`, `checkAllowedGroups`), docs oauth2-proxy.github.io/oauth2-proxy/configuration/overview/ |
| cert-manager | v1.21.3 (2026-10-23), chart `oci://quay.io/jetstack/charts/cert-manager`, archive `sha256:9ec67938...bb373a17`; its five images (controller, webhook, cainjector, acmesolver, startupapicheck) pinned by digest in `helm/cert-manager-values.yaml` (multi-arch index digests on quay.io, read 2026-11-12) | cert-manager.io/docs/installation/helm/ and /docs/configuration/acme/http01/ (Gateway API solver, `config.gatewayAPI.enabled=true`); `crds.enabled`, `crds.keep` and `config.gatewayAPI.enabled` in the chart's `values.yaml` (read 2026-11-12) |
| busybox (smoke test) | 1.38.0 with digest | same pin as the service charts |
| kubeconform | v0.8.0 (image `ghcr.io/yannh/kubeconform` pinned by digest in the pipeline), Kubernetes schemas 1.35.0, CRD schemas of github.com/datreeio/CRDs-catalog at commit `89c736bd` | local checks below; image pin copied from the organization's `service-ci-cd.yml` |
| Helm | v4.3.1 (ADR-047), locally and in the pipeline | `helm version` |
| actionlint | 1.7.12, image pinned by digest | same pin as the organization's workflows |
| Pipeline actions | pinned by commit SHA (checkout v7.0.1, setup-node v7.1.0, setup-helm v5.0.1, upload-artifact v7.0.2) | the SHAs of the organization's `service-ci-cd.yml` |

Sizes (ADR-034 and ADR-039): one replica each; Traefik requests 50m and 64Mi, limit 128Mi; oauth2-proxy requests 10m
and 32Mi, limit 64Mi. The schema allows at most two oauth2-proxy replicas (a high-availability demo); the Traefik
replicas are set in `traefik-values.yaml` (the RateLimit counters are per replica).

## Deploy

The organization's shared pipeline deploys the gateway on every push to `main` (and on a manual run), like the services
(`.github/workflows/ci-cd.yml`, "Pipeline" below). Namespaces: Traefik and this chart in `gateway` (the services'
NetworkPolicies admit the Traefik Pods of that namespace, but not oauth2-proxy: see "Not done yet"), cert-manager in
`cert-manager`, the services in `prod`. Before anything changes, the deploy stops when the release `gateway`,
`cert-manager` or `traefik` is stuck from an interrupted deploy, and names the fix. Then in this order, each step only
after the one before succeeded:

| # | What | How (shared workflow, deploy job) |
|---|---|---|
| 1 | Gateway API CRDs v1.6.3, Standard channel (cluster-wide), before cert-manager and Traefik start | input `prerequisite-manifests`: the release file is downloaded, its sha256 checked against the pin, applied with `kubectl apply --server-side` (field manager `ci-cd`), then the job waits until the CRDs are Established |
| 2 | cert-manager v1.21.3 with Gateway API support (its CRDs are part of the release) | input `prerequisite-charts`, line 1: chart archive checked against its sha256, `helm upgrade --install cert-manager` into `cert-manager` (created when missing) with `helm/cert-manager-values.yaml`, `--rollback-on-failure --wait` |
| 3 | Traefik, chart 42.3.1 (its CRDs and the GatewayClass) | line 2: the same, release `traefik` in `gateway`; the CRDs of its `crds/` folder are applied server-side first (Helm never upgrades them) and the release runs with `--skip-crds`; with `helm/traefik-values.yaml` |
| 4 | The Secret `gateway-env` from the organization secret `GATEWAY_ENV` | secret `app-env` (server-side apply, values masked in the log) |
| 5 | This chart, release `gateway` in `gateway` | `values-prod.yaml`, then `hostname` from `PUBLIC_HOST` (input `host-values`), `tls.issuer.acme.email` from the organization secret `ACME_EMAIL` (secret `secret-values`, passed to Helm as a file, masked in the log; an empty value stops the deploy), `podAnnotations.checksum/app-env` from the pipeline; `--rollback-on-failure --wait` |
| 6 | Smoke test | `helm test gateway`; when it fails, the release `gateway` is rolled back (cert-manager, Traefik and the CRDs stay as installed) |

The pull request check (`pipeline / test`) downloads the same files, checks the same digests and validates them, so a
wrong pin fails before the merge. Done once by hand, before the first deploy:

- the namespace `gateway` (`kubectl create namespace gateway`; the deploy only checks that it exists, as for `prod`);
- the organization variable `PUBLIC_HOST`, the organization secret `ACME_EMAIL` (the contact address of the Let's
  Encrypt account; a secret, so it shows neither in this public repository nor in its run logs) and the organization
  secret `GATEWAY_ENV` (names in `.env.example`; the cookie secret has to be 16, 24 or 32 bytes), all visible to this
  repository;
- after the first deploy: point the DNS name `PUBLIC_HOST` at the external IP of the Service `traefik`
  (`kubectl -n gateway get svc traefik`).

The release name has to be `gateway` and the namespace `gateway`: `traefik-values.yaml` scopes Traefik to that Gateway,
and the smoke test and `traefikAddress` name the Service `traefik` in `gateway`. After the first deploy, the Certificate
reaches Ready when the DNS name resolves and the `http` listener is reachable on port 80 from the internet.

### Update a prerequisite

A new version of the Gateway API CRDs, cert-manager or Traefik changes its line in `.github/workflows/ci-cd.yml`: the
version and the sha256 of the new file together (Dependabot sees neither). For Traefik also `TRAEFIK_CHART_VERSION` in
`chart-ci.yml` (its step "Same Traefik version as the deploy" fails while the two differ), and `traefik-values.yaml`
when the chart's values changed; for the Gateway API also the version Traefik supports (table "Versions"); for
cert-manager also the digests of its five images in `cert-manager-values.yaml` (controller, webhook, cainjector,
acmesolver, startupapicheck: the chart takes them from `image.digest`, `webhook.image.digest` and so on). The digests:

```bash
curl -fsSL https://github.com/kubernetes-sigs/gateway-api/releases/download/vX.Y.Z/standard-install.yaml | sha256sum
helm pull oci://quay.io/jetstack/charts/cert-manager --version vX.Y.Z -d /tmp/pin && sha256sum /tmp/pin/cert-manager-vX.Y.Z.tgz
helm pull traefik --repo https://traefik.github.io/charts --version X.Y.Z -d /tmp/pin && sha256sum /tmp/pin/traefik-X.Y.Z.tgz
# the five cert-manager images of tag vX.Y.Z (the digest of the multi-arch index)
for name in controller webhook cainjector acmesolver startupapicheck; do
  docker buildx imagetools inspect "quay.io/jetstack/cert-manager-$name:vX.Y.Z" --format '{{.Manifest.Digest}}'
done
```

Traefik's CRDs (its `crds/` folder) need nothing by hand: the pipeline applies them server-side before every Traefik
release (Helm alone would install them once and never upgrade them), so a chart upgrade brings its new CRDs.

A manual run (input `sha`) installs the prerequisites of the newest `ci-cd.yml` of `main` with the values files of the
commit it deploys; roll a prerequisite back by reverting its line on `main`.

## Local checks

No cluster is needed. The commands render the chart and validate the manifests against the schemas of Kubernetes,
Gateway API, Traefik and cert-manager. Needed on the machine: Helm 4 and kubeconform v0.8.0 (the pipeline runs
kubeconform from its pinned image instead), Node.js 24 and npm for the tests, and a Docker daemon for the stack tests.

```bash
helm lint helm --values helm/values-prod.yaml --namespace gateway --strict
helm template gateway helm --namespace gateway --values helm/values-prod.yaml \
  | kubeconform -strict -summary -kubernetes-version 1.35.0 -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/89c736bdde38b5fecd0f8436ec5f3aa3679a3b86/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' -
```

Run the same with `values-dev.yaml`, and once more for the Traefik chart that carries `helm/traefik-values.yaml`
(`helm template traefik traefik --repo https://traefik.github.io/charts --version 42.3.1 --namespace gateway
--values helm/traefik-values.yaml`, piped into the same kubeconform command); the cert-manager chart renders with
`helm template cert-manager oci://quay.io/jetstack/charts/cert-manager --version v1.21.3 --namespace cert-manager
--values helm/cert-manager-values.yaml` (its six CRDs have no schema to check against, the rest does). `values.schema.json` refuses an unknown key (so no `clientSecret`), an extra
environment name that contains SECRET, PASSWORD, TOKEN, PRIVATE or CREDENTIAL, an image without a digest, a malformed
host name and more than two oauth2-proxy replicas.

## Local proof

`local/compose.yaml` runs the chart's Traefik (v3.7.17, same digest) and oauth2-proxy (v7.15.6, same digest and
settings) in Docker, with a stub identity provider (BusyBox `httpd` serving the signing keys of a key pair made for each
run, and a discovery document, at the Keycloak paths) and one echo container per backend Service (`traefik/whoami`
v1.12.0, named like the chart's Services, port 8080), so a test sees which backend answered and what it received. There
is no cluster and no Keycloak. Traefik's Gateway API provider needs a Kubernetes API server, so the routes are written
as Traefik file-provider configuration (`local/traefik/dynamic.yaml`) with the rules and priorities that the Gateway
provider computes from the chart's HTTPRoutes (formula in the file's header; source `httproute.go`, `buildMatchRule`,
v3.7.17).

```bash
npm install
npm run lint && npm run typecheck
npm test            # drift tests: the chart rendered by Helm against local/ (needs helm, no Docker)
npm run test:e2e    # starts the stack, runs the tests, removes the containers (needs a Docker daemon)
npm run stack:down  # removes what a killed run left behind, by container name (gw-e2e-*)
```

| Test file | What it proves |
|---|---|
| `tests/drift/chart-and-local.test.ts` | The prefix to service table, the rules and priorities, the middleware chains, the oauth2-proxy settings, the image pins and the entry point hardening are the same in the chart (`helm template`, three value sets) and in `local/`. |
| `tests/e2e/routing.test.ts` | Every prefix of the plan's table reaches its backend with the path unchanged and the token passed on; a method rule and an exact path win over a prefix; near-miss prefixes reach no service; another Host matches nothing. |
| `tests/e2e/auth.test.ts` | No token gives 401 on every protected route; a valid token of the wrong role gives 403 on the platform-admin class, and the tenant-role routes (audit, members, invites, market lifecycle) need only a valid token at the edge; another issuer, another audience, an expired token, another key, `alg` none, HS256, Basic credentials and a token in the query string give 401; public routes need no token. |
| `tests/e2e/blocked.test.ts` | `/v1/internal` (also markets' share-link admission check for tenants), `/admin` and the master realm answer 403 for every caller; spellings of them (`//`, `..`, `%2e`, `%69`, case, `;`) and encoded slashes, backslashes, nulls and percent signs never reach a service. |
| `tests/e2e/headers.test.ts` | `Cache-Control: private, no-store` on API, public, 401 and 403 responses; `X-Correlation-Id` reaches the backend; a client's `X-Forwarded-For` and alias headers (`X_Auth_User`) are not trusted; the ten identity headers (`X-Auth-Request-*`, `X-Forwarded-User` and its kin) a client sends are absent at the backend on every route of the table. |
| `tests/e2e/ratelimit.test.ts` | A burst on `/v1/trading` gets 429 (with the no-store header) while the same burst on another API route does not; a flood of the public share-link lookup gets 429 at the public limit. |
| `tests/e2e/idp.test.ts` | The stub serves the key and the discovery document at the paths of the realm. |

What the proof found (all fixed in the chart, each covered by a test):

- `GET /v1/tenants/` (trailing slash) matched the prefix rule, which any valid token passes, instead of the platform-admin
  rule of the exact path `/v1/tenants`. The exact path with the slash is now listed too.
- Traefik v3.7 lets encoded slashes, backslashes, nulls, semicolons, percent signs, question marks and hashes through in
  the path by default (docs: "entrypoints" reference, `http.encodedCharacters`, all `true`): `/v1/trading/..%2finternal`
  reached trading as written. `traefik-values.yaml` now rejects them on both entry points (answer 400).
- Headers whose names alias another header (`X_Auth_User` for `X-Auth-User`) are forwarded by default
  (`aliasHeadersStrategy: keep`); both entry points now delete them.

Not covered, because it needs a cluster: the Gateway API resources and Traefik's translation of them (only its formula
is mirrored and compared), TLS with cert-manager and the HTTP to HTTPS redirect, the NetworkPolicy, probes and the smoke
test. The tokens are made with the claims of the realm file (`realm_access.roles`, audience `chance`), not issued by
Keycloak.

## Pipeline

`.github/workflows/ci-cd.yml` runs on every pull request, every push to `main` and on a manual run. Its job `pipeline`
calls the organization's shared `service-ci-cd.yml` (`RSO-ekipa10/.github`) with `build-image: false` (no code, no
image), `namespace: gateway`, the host and ACME values and the three prerequisites; its job `chart-rules` calls
`chart-ci.yml` for the checks the shared workflow does not run. On a push to `main`, `pipeline` (and with it the deploy)
starts only when `chart-rules` passed.

| Check | Steps |
|---|---|
| `pipeline / test` | workflow lint (actionlint), Helm 4 version check, the host and ACME values (the stand-in host `public-host.invalid` when the organization variables are missing; without the organization secret `ACME_EMAIL`, as in a pull request from a fork, a warning and the checks without the address), the Gateway API CRDs, cert-manager and Traefik downloaded, checked against their sha256 pins and validated with kubeconform (the CRDs themselves are parsed only: kubeconform's Kubernetes schemas have none for `CustomResourceDefinition`), `helm lint` and kubeconform of this chart with the dev and prod values, no local address in the prod values (localhost, `.localhost`, `127.x`, `0.0.0.0`, `::1`; the organization's README, "Prod values hold no local address"), the `helm test` hook check |
| `pipeline / deploy` | push to `main` and manual runs only: "Deploy" above |
| `chart-rules / test` | workflow lint, `npm ci`, ESLint, `tsc`, `helm lint --strict` with default, dev and prod values, kubeconform with the Gateway API, Traefik and cert-manager schemas (`-kubernetes-version 1.35.0`, CRD catalog) on this chart (dev, prod) and on the Traefik chart with `traefik-values.yaml`, the Traefik version the same as in `ci-cd.yml`, the `helm test` hook check, the drift tests (`npm test`) |
| `chart-rules / e2e` | `npm ci`, the tests against the Docker stack (`npm run test:e2e`), a cleanup of leftover containers, the reports kept for 7 days |

`chart-ci.yml` follows the shared workflow's style: every action pinned to a full commit SHA (the same SHAs),
`contents: read` only, Helm 4, the same actionlint and kubeconform images by digest, `defaults.run.shell: bash`. The
concurrency rule of `ci-cd.yml` is the services' one: a newer push cancels an older pull request run, a run on `main`
never cancels a running one. Tool versions in the `env` block of `chart-ci.yml` are bumped by hand, as there.

`.github/dependabot.yml` proposes weekly updates for npm, GitHub Actions and the images in `local/compose.yaml`
(minor and patch together, major one by one); the drift test fails when the compose images and the chart's images
drift apart, so a bump needs the matching change in `helm/values.yaml`. `.github/CODEOWNERS` asks the other team
member to review changes to `.github/`, `helm/`, `tests/` and `local/`.

## Not done yet

- **First deploy.** Nothing has run in a cluster yet. The pipeline needs the commit of `RSO-ekipa10/.github` that adds
  the inputs `prerequisite-manifests` and `prerequisite-charts` and the secret `secret-values` on its `main` first (until then GitHub
  refuses `ci-cd.yml` with "Invalid input"), then the one-time steps of "Deploy".
- **GitHub repository.** `RSO-ekipa10/gateway` is not created; no branch ruleset exists for it (the deploy identity
  already lists it in the infrastructure's Terraform). When it is added, `chart-rules / test` and `chart-rules / e2e`
  should be required checks next to `pipeline / test`.
- **Public host and certificate.** The host name and the ACME contact address are not known (INF-01): `chance.example`
  in the values until the organization variable `PUBLIC_HOST` and the organization secret `ACME_EMAIL` exist. The certificate needs the DNS
  name to point at the Traefik Service first.
- **Web UI.** `/` goes to a placeholder Service `web` (port 8080) that does not exist; the route answers 500 until the UI
  is built and its Service is named accordingly (`routes.web` in `helm/values.yaml`).
- **Organization secret.** `GATEWAY_ENV` is not created; the pipeline turns it into the Secret `gateway-env`, which
  holds the two oauth2-proxy secrets (`.env.example`), and a hash of it into the Pod annotation `checksum/app-env`
  (value `podAnnotations`), so oauth2-proxy restarts when the secrets change.
- **Identity's NetworkPolicy.** oauth2-proxy fetches the signing keys from the identity Service in `prod`
  (`oauth2-proxy.yaml`, `OAUTH2_PROXY_OIDC_JWKS_URL`). The identity chart's NetworkPolicy (off by default) admits the
  Traefik Pods and, since 2026-11-11, the oauth2-proxy Pods (`networkPolicy.tokenCheckPodLabels`) of the namespace
  `gateway`, plus the Pods of its own namespace. The `helm test` cannot show a blocked key fetch: a request without a
  token is refused with 401 without any key, and so is a token whose keys cannot be fetched. After the first install,
  check with a real token (a 200 from `/v1/me`), not with the smoke test alone.
- **Not provable without a cluster** (listed under "Local proof"): Traefik's own translation of the Gateway API
  resources, cert-manager, the redirect, the NetworkPolicy, probes and `helm test`. These are the first things to
  check after the first install.

## Known limits and open points

- The `e2e` job pulls four public images (Traefik, oauth2-proxy, BusyBox, whoami) without a login; a run can fail on a
  registry rate limit of a shared runner address, and a re-run fixes it.
- Auth fails closed when oauth2-proxy is down by construction (Traefik's ForwardAuth answers 5xx when it cannot reach
  its address and has no fail-open switch; every protected chain ends in an `auth-*` entry, and the tests prove the 401
  without a token on every protected route), but no test stops the oauth2-proxy container and looks at the answer.
- The `helm test` on the HTTPS listener checks only that HTTP redirects (301); the deny rule and the no-store header
  are proven locally (`tests/e2e/blocked.test.ts`, `headers.test.ts`) and are to be checked by hand on the HTTPS
  listener after the first install (INF-02 asks that no API response comes from a cache).
- The services' namespace `prod` follows the plan's checklist (one namespace per environment holding all services);
  `services.namespace` changes it.
- RateLimit counts per client address and per Traefik replica; `externalTrafficPolicy: Local` keeps the client address
  on AKS. Behind a proxy that is not trusted the address is the proxy's.
- Cache rules for the web UI (`index.html` `no-cache`, hashed files long cache) belong to the web UI, not to the gateway.
- Gateway API v1.7.0 is out; Traefik 3.7 documents v1.6.3, so that is what the install uses.
