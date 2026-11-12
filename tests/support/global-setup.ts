import { request } from "node:http";
import type { TestProject } from "vitest/node";

import { down, up } from "./stack.js";
import type { StackInfo } from "./stack.js";
import { makeSigner } from "./tokens.js";

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

function status(baseUrl: string, host: string, path: string, token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request(`${baseUrl}${path}`, { headers: { host, authorization: `Bearer ${token}` }, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** Starts the stack, waits until a token passes the whole chain (Traefik, oauth2-proxy, the keys), removes it at the end. */
export default async function setup(project: TestProject): Promise<() => void> {
  let teardownDone = false;
  const teardown = (): void => {
    if (!teardownDone) {
      teardownDone = true;
      down();
    }
  };
  try {
    const info = up();
    const token = makeSigner(info.privateKeyPem)({ groups: ["/trader"] });
    const deadline = Date.now() + 90_000;
    let code = 0;
    while (Date.now() < deadline && code !== 200) {
      code = await status(info.baseUrl, info.host, "/v1/me", token);
      if (code !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (code !== 200) {
      throw new Error(`the stack did not become ready: GET /v1/me answered ${code}`);
    }
    project.provide("stack", info);
  } catch (error) {
    teardown();
    throw error;
  }
  return teardown;
}
