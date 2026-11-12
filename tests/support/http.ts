import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { inject } from "vitest";

import { makeSigner } from "./tokens.js";
import type { TokenSpec } from "./tokens.js";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The name of the echo backend that answered (the "Name:" line of the echo), or null when no backend did. */
  backend: string | null;
  /** The request as the backend saw it: its request line path and its headers (names in lower case). */
  seen: { path: string | null; headers: Record<string, string> };
}

export interface Call {
  method?: string;
  /** Sent as written (no normalization), so that "/v1//internal", "../" and "%69" reach the gateway as they are. */
  path: string;
  token?: string;
  headers?: Record<string, string>;
  host?: string;
  /** Skip the pacing below: for the tests that exercise the rate limits on purpose. */
  unpaced?: boolean;
}

function parseEcho(body: string): Pick<Reply, "backend" | "seen"> {
  const name = /^Name: (\S+)$/m.exec(body);
  const seen: Reply["seen"] = { path: null, headers: {} };
  if (!name) {
    return { backend: null, seen };
  }
  // The echo writes the request as it came over the wire, with CRLF line ends.
  for (const line of body.split(/\r?\n/)) {
    const requestLine = /^[A-Z]+ (\S+) HTTP\/1\.[01]$/.exec(line);
    if (requestLine) {
      seen.path = requestLine[1] ?? null;
      continue;
    }
    const header = /^([A-Za-z0-9_.-]+): (.*)$/.exec(line);
    if (header && !["Name", "Hostname", "IP", "RemoteAddr"].includes(header[1] ?? "")) {
      seen.headers[(header[1] ?? "").toLowerCase()] = header[2] ?? "";
    }
  }
  return { backend: name[1] ?? null, seen };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The gateway limits requests per client address (trading 10 per second, other API routes 50, public routes 20). The
// tests send one after another much faster than that, so each request waits for its slot, a little under the limit.
const SPACING_MS: Record<string, number> = { trading: 120, api: 30, public: 60 };
const nextFree = new Map<string, number>();

async function pace(path: string): Promise<void> {
  const bucket = path.startsWith("/v1/trading") ? "trading" : path.startsWith("/v1/") ? "api" : "public";
  const now = Date.now();
  const at = Math.max(now, nextFree.get(bucket) ?? 0);
  nextFree.set(bucket, at + (SPACING_MS[bucket] ?? 60));
  if (at > now) {
    await sleep(at - now);
  }
}

/** One HTTP request to the gateway under test. */
export async function send(call: Call): Promise<Reply> {
  const stack = inject("stack");
  if (!call.unpaced) {
    await pace(call.path);
  }
  const headers: Record<string, string> = { host: call.host ?? stack.host, ...call.headers };
  if (call.token !== undefined) {
    headers["authorization"] = `Bearer ${call.token}`;
  }
  const url = new URL(stack.baseUrl);
  return new Promise((resolve, reject) => {
    // Options instead of a URL string: a URL would normalize the path before it is sent.
    const req = request(
      { host: url.hostname, port: Number(url.port), path: call.path, method: call.method ?? "GET", headers, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ...parseEcho(body) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${call.method ?? "GET"} ${call.path}`)));
    req.end();
  });
}

/** Tokens signed with the key of this run's stub identity provider. */
export function tokenOf(spec?: TokenSpec): string {
  return makeSigner(inject("stack").privateKeyPem)(spec);
}
