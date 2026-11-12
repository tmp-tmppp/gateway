import { spawnSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

import { ROOT, chartRouters, chartTable, helmTemplate, localRouters, readYaml } from "../support/chart.js";
import type { Doc } from "../support/chart.js";
import { IDENTITY_HEADERS } from "../support/table.js";

// The local proof (local/) shows that the routes and the checks work; this file shows that it proves the chart and not
// a copy that drifted. Both sides are read as they are: Helm renders the chart, local/ is parsed from its files.
const variants: [string, string[]][] = [
  ["default values", []],
  ["values-dev.yaml", ["-f", "helm/values-dev.yaml"]],
  ["values-prod.yaml", ["-f", "helm/values-prod.yaml"]],
];

const rendered = new Map<string, Doc[]>();
beforeAll(() => {
  for (const [name, args] of variants) {
    rendered.set(name, helmTemplate(args));
  }
});

describe("the route table (prefix to service) of the chart and of the local routes is the same", () => {
  for (const [name] of variants) {
    it(`${name}: every match, path type, method and backend`, () => {
      expect(chartTable(rendered.get(name) ?? [])).toEqual(localRouters().table);
    });
  }

  it("the table is not empty and names every service of the plan's routing table", () => {
    const backends = new Set(localRouters().table.map((m) => m.backend.split(":")[0]));
    for (const service of ["markets", "trading", "market-data", "tenants", "payments", "audit", "payment-provider", "identity", "web"]) {
      expect(backends, service).toContain(service);
    }
  });
});

describe("rules, priorities and middleware chains", () => {
  it("the routers Traefik builds from the chart's HTTPRoutes are the local routers (default values)", () => {
    expect(localRouters().routers).toEqual(chartRouters(rendered.get("default values") ?? []));
  });
});

describe("middlewares", () => {
  const normalize = (spec: Doc): Doc => {
    const copy = structuredClone(spec);
    if (copy["chain"]) {
      // The chart's chain lists {name} objects; the file provider lists names.
      copy["chain"] = { middlewares: (copy["chain"]["middlewares"] as (Doc | string)[]).map((m) => (typeof m === "string" ? m : m["name"])) };
    }
    if (copy["forwardAuth"]) {
      // The Service of oauth2-proxy is addressed by its namespace in the cluster and by its name in Compose.
      copy["forwardAuth"]["address"] = String(copy["forwardAuth"]["address"]).replace(".gateway.svc", "");
    }
    return copy;
  };

  it("the same names with the same settings, chains in the same order", () => {
    const chart = Object.fromEntries(
      (rendered.get("default values") ?? [])
        .filter((d) => d["kind"] === "Middleware")
        .map((d) => [d["metadata"]["name"] as string, normalize(d["spec"])]),
    );
    const local = Object.fromEntries(Object.entries(localRouters().middlewares).map(([name, spec]) => [name, normalize(spec as Doc)]));
    expect(Object.keys(local).sort()).toEqual(Object.keys(chart).sort());
    expect(local).toEqual(chart);
  });
});

describe("identity headers a client sends are deleted first, on every route class", () => {
  for (const [name] of variants) {
    it(`${name}: strip-identity deletes exactly the identity headers and starts every chain`, () => {
      const middlewares = (rendered.get(name) ?? []).filter((d) => d["kind"] === "Middleware");
      const strip = middlewares.find((d) => d["metadata"]["name"] === "gateway-strip-identity");
      expect(strip?.["spec"]["headers"]["customRequestHeaders"]).toEqual(Object.fromEntries(IDENTITY_HEADERS.map((header) => [header, ""])));
      const chains = middlewares.filter((d) => d["spec"]["chain"]);
      // public, static, web, user, trading, platform-admin, deny (the tenant-admin class is gone: token contract v2).
      expect(chains.length).toBeGreaterThanOrEqual(7);
      for (const chain of chains) {
        expect(chain["spec"]["chain"]["middlewares"][0]["name"], chain["metadata"]["name"]).toBe("gateway-strip-identity");
      }
    });
  }
});

describe("oauth2-proxy", () => {
  const compose = (): Doc => readYaml("local/compose.yaml");

  it("runs with the settings of the chart's ConfigMap (only the address of the signing keys differs)", () => {
    const configMap = (rendered.get("default values") ?? []).find((d) => d["kind"] === "ConfigMap" && d["metadata"]["name"] === "gateway-oauth2-proxy");
    const chart: Record<string, string> = { ...(configMap?.["data"] as Record<string, string>) };
    for (const key of ["OAUTH2_PROXY_OIDC_JWKS_URL", "OAUTH2_PROXY_REDEEM_URL"]) {
      chart[key] = (chart[key] ?? "").replace("http://identity.prod.svc:8080", "http://idp:8080");
    }
    const env: Record<string, string> = { ...compose()["services"]["gateway-oauth2-proxy"]["environment"] };
    // The two secrets come from the Secret gateway-env in the cluster and from the test run here.
    expect(env["OAUTH2_PROXY_CLIENT_SECRET"]).toMatch(/^\$\{OAUTH2_PROXY_CLIENT_SECRET:\?/);
    expect(env["OAUTH2_PROXY_COOKIE_SECRET"]).toMatch(/^\$\{OAUTH2_PROXY_COOKIE_SECRET:\?/);
    delete env["OAUTH2_PROXY_CLIENT_SECRET"];
    delete env["OAUTH2_PROXY_COOKIE_SECRET"];
    expect(env).toEqual(chart);
  });

  it("uses the image of the chart (tag and digest)", () => {
    expect(compose()["services"]["gateway-oauth2-proxy"]["image"]).toBe(readYaml("helm/values.yaml")["auth"]["image"]);
  });

  it("writes every Pod annotation once: the pipeline's, auth.podAnnotations, and checksum/config from the chart only", () => {
    const render = spawnSync("helm", ["template", "gateway", "helm", "--namespace", "gateway", "-f", "helm/values-prod.yaml",
      "--set-string", "podAnnotations.checksum/app-env=0123abcd", "--set-string", "podAnnotations.checksum/config=from-pipeline",
      "--set-string", "auth.podAnnotations.checksum/config=from-auth", "--set-string", "auth.podAnnotations.team=chance",
      "--set-string", "auth.podAnnotations.checksum/app-env=from-auth"], { cwd: ROOT, encoding: "utf8" });
    expect(render.status, render.stderr).toBe(0);
    // Parsed with unique keys enforced, so a repeated annotation fails here instead of one value silently winning.
    const docs = parseAllDocuments(render.stdout);
    for (const doc of docs) {
      expect(doc.errors.map((e) => e.message)).toEqual([]);
    }
    const deployment = docs.map((d) => d.toJS() as Doc).find((d) => d?.["kind"] === "Deployment" && d["metadata"]["name"] === "gateway-oauth2-proxy");
    const annotations = deployment?.["spec"]["template"]["metadata"]["annotations"] as Record<string, string>;
    expect(annotations["checksum/config"]).toMatch(/^[0-9a-f]{16}$/);
    expect(annotations["checksum/app-env"]).toBe("0123abcd");
    expect(annotations["team"]).toBe("chance");
  });
});

describe("Traefik and the backends", () => {
  it("applies the request hardening of the Traefik chart values (encoded characters, alias headers) on its entry point", () => {
    const chart = readYaml("helm/traefik-values.yaml")["ports"];
    const local = readYaml("local/traefik/traefik.yaml")["entryPoints"]["web"]["http"];
    expect(local).toEqual(chart["web"]["http"]);
    expect(chart["websecure"]["http"]).toEqual(chart["web"]["http"]);
    expect(Object.values<boolean>(local["encodedCharacters"]).every((allowed) => allowed === false)).toBe(true);
  });

  it("serves Prometheus metrics on their own entry point on 9464, never on web or websecure, and not through the Service", () => {
    const values = readYaml("helm/traefik-values.yaml");
    const ports = values["ports"] as Record<string, Doc>;
    const entryPoint = values["metrics"]["prometheus"]["entryPoint"] as string;
    expect(entryPoint).toBe("metrics");
    expect(entryPoint).not.toBe("web");
    expect(entryPoint).not.toBe("websecure");
    // The chart's default is 9100; the platform's convention (METRICS_PORT) is 9464, and it is its own port.
    expect(ports[entryPoint]?.["port"]).toBe(9464);
    expect([ports["web"]?.["port"], ports["websecure"]?.["port"]]).not.toContain(9464);
    // Not in the LoadBalancer Service: the public address never carries /metrics.
    expect(ports[entryPoint]?.["expose"]).toEqual({ default: false });
    // The chart builds the three prometheus.io annotations from the two values above; a second set would repeat the keys.
    expect(values["deployment"]?.["podAnnotations"]).toBeUndefined();
  });

  it("watches IngressRoutes and Middlewares only in the namespace of the Gateway, so none created elsewhere becomes a public route", () => {
    const providers = readYaml("helm/traefik-values.yaml")["providers"];
    const gateways = providers["kubernetesGateway"]["gateways"] as { name: string; namespace: string }[];
    expect(providers["kubernetesCRD"]["namespaces"]).toEqual(["gateway"]);
    expect(gateways.map((g) => g.namespace)).toEqual(["gateway"]);
    expect(providers["kubernetesIngress"]["enabled"]).toBe(false);
  });

  it("runs the version of the Traefik chart values (tag and digest)", () => {
    const image = readYaml("helm/traefik-values.yaml")["image"];
    expect(readYaml("local/compose.yaml")["services"]["traefik"]["image"]).toBe(`traefik:${image["tag"]}@${image["digest"]}`);
  });

  it("has one echo backend per Service of the chart, with its name and port", () => {
    const backends = readYaml("helm/values.yaml")["backends"] as Record<string, { service: string; port: number }>;
    const services = readYaml("local/compose.yaml")["services"] as Doc;
    for (const { service, port } of Object.values(backends)) {
      expect(services[service]?.["command"], service).toEqual(["--port", String(port), "--name", service]);
    }
  });

  it("the stub identity provider uses the image of the chart's smoke test", () => {
    expect(readYaml("local/compose.yaml")["services"]["idp"]["image"]).toBe(readYaml("helm/values.yaml")["smokeTest"]["image"]);
  });
});
