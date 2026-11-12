import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Doc = Record<string, any>;

/** Renders the chart as the pipeline does (release "gateway" in the namespace "gateway") and returns its objects. */
export function helmTemplate(extraArgs: string[] = []): Doc[] {
  const run = spawnSync("helm", ["template", "gateway", "helm", "--namespace", "gateway", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`helm template failed:\n${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((d) => d.toJS() as Doc | null)
    .filter((d): d is Doc => d !== null && typeof d === "object");
}

export function readYaml(relativePath: string): Doc {
  return parse(readFileSync(join(ROOT, relativePath), "utf8")) as Doc;
}

/** One match of one rule of one route: what a request has to look like and where it goes. */
export interface Match {
  path: string;
  type: "Exact" | "PathPrefix";
  method: string;
  backend: string;
}

/** A router the way Traefik's Gateway API provider builds it (v3.7.17, httproute.go, buildMatchRule). */
export interface Router {
  rule: string;
  priority: number;
  middleware: string;
  backend: string;
}

interface RuleMatch {
  match: Match;
  router: Router;
}

function expand(docs: Doc[]): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const route of docs.filter((d) => d["kind"] === "HTTPRoute")) {
    const rules: Doc[] = route["spec"]["rules"];
    const host: string = route["spec"]["hostnames"][0];
    rules.forEach((rule, ri) => {
      const filter = (rule["filters"] as Doc[]).find((f) => f["type"] === "ExtensionRef");
      if (!filter) {
        return; // the HTTP to HTTPS redirect has a RequestRedirect filter and no middleware
      }
      const ref = (rule["backendRefs"] as Doc[])[0] as Doc;
      for (const m of rule["matches"] as Doc[]) {
        const type = m["path"]["type"] as Match["type"];
        const value = m["path"]["value"] as string;
        const method = (m["method"] as string | undefined) ?? "";
        let pathRule: string;
        let priority: number;
        if (type === "Exact") {
          pathRule = `Path("${value}")`;
          priority = 100000;
        } else if (value === "/") {
          pathRule = `PathPrefix("/")`;
          priority = 1;
        } else {
          const trimmed = value.replace(/\/$/, "");
          pathRule = `(Path("${trimmed}") || PathPrefix("${trimmed}/"))`;
          priority = 10000 + value.length * 100;
        }
        const parts = [`Host("${host}")`, pathRule];
        if (method) {
          parts.push(`Method("${method}")`);
          priority += 1000;
        }
        priority += host.length + (rules.length - ri);
        out.push({
          match: { path: value, type, method, backend: `${ref["name"]}:${ref["port"]}` },
          router: {
            rule: parts.join(" && "),
            priority,
            middleware: (filter["extensionRef"] as Doc)["name"],
            backend: `${ref["name"]}:${ref["port"]}`,
          },
        });
      }
    });
  }
  return out;
}

/** The route table of the chart: path, type, method and backend of every match, sorted. */
export function chartTable(docs: Doc[]): Match[] {
  return sortBy(expand(docs).map((e) => e.match), (m) => `${m.path}|${m.type}|${m.method}`);
}

/** The routers Traefik would build from the chart's HTTPRoutes, sorted. */
export function chartRouters(docs: Doc[]): Router[] {
  return sortBy(expand(docs).map((e) => e.router), (r) => r.rule);
}

function stripUrl(url: string): string {
  return url.replace(/^http:\/\//, "");
}

/** The routers of the local proof (local/traefik/dynamic.yaml), sorted, and its route table derived from the rules. */
export function localRouters(): { routers: Router[]; table: Match[]; middlewares: Doc } {
  const http = (readYaml("local/traefik/dynamic.yaml")["http"] ?? {}) as Doc;
  const routers: Router[] = [];
  const table: Match[] = [];
  for (const r of Object.values<Doc>(http["routers"])) {
    const service = http["services"][r["service"]];
    const backend = stripUrl(service["loadBalancer"]["servers"][0]["url"] as string);
    const rule = r["rule"] as string;
    routers.push({ rule, priority: r["priority"], middleware: (r["middlewares"] as string[]).join(","), backend });
    const exact = /Host\("[^"]+"\) && Path\("([^"]+)"\)/.exec(rule);
    const prefix = /\(Path\("([^"]+)"\) \|\| PathPrefix\("[^"]+"\)\)/.exec(rule);
    const catchAll = /PathPrefix\("\/"\)$/.test(rule) || /&& PathPrefix\("\/"\)/.test(rule);
    const method = /Method\("([A-Z]+)"\)/.exec(rule)?.[1] ?? "";
    if (exact?.[1]) {
      table.push({ path: exact[1], type: "Exact", method, backend });
    } else if (prefix?.[1]) {
      table.push({ path: prefix[1], type: "PathPrefix", method, backend });
    } else if (catchAll) {
      table.push({ path: "/", type: "PathPrefix", method, backend });
    } else {
      throw new Error(`cannot read the path of the rule ${rule}`);
    }
  }
  return {
    routers: sortBy(routers, (r) => r.rule),
    table: sortBy(table, (m) => `${m.path}|${m.type}|${m.method}`),
    middlewares: http["middlewares"] as Doc,
  };
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}
