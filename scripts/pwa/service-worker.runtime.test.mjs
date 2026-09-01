// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { buildServiceWorkerSource } from "./service-worker.mjs";

const ORIGIN = "https://chooser.example";

describe("generated service-worker runtime", () => {
  it("leaves the active cache untouched when staging install fails", async () => {
    const worker = createWorker({
      precacheUrls: ["/"],
      failingPath: "/",
    });
    const active = await worker.caches.open("chooser-web-release-old");
    await active.put(request("/old"), response("old"));

    await expect(worker.dispatchLifecycle("install")).rejects.toThrow();

    expect(await worker.caches.match("/old")).toBeDefined();
    expect(await worker.caches.keys()).toEqual(["chooser-web-release-old"]);
  });

  it("adopts a complete release, handshakes, and serves known routes cache-first", async () => {
    const worker = createWorker({
      precacheUrls: ["/", "/legal/gpl-3.0.txt", "/settings/"],
    });
    const old = await worker.caches.open("chooser-web-release-old");
    await old.put(request("/old"), response("old"));

    await worker.dispatchLifecycle("install");
    await worker.dispatchLifecycle("activate");

    expect(worker.clients.claimed).toBe(true);
    expect(await worker.caches.match("/old")).toBeUndefined();

    const target = {
      messages: [],
      postMessage(message) {
        this.messages.push(message);
      },
    };
    await worker.dispatchMessage(
      {
        type: "CHOOSER_PWA_HANDSHAKE",
        buildId: "build-a",
        requestId: "build-a:1",
      },
      target,
    );
    expect(target.messages).toEqual([
      expect.objectContaining({
        type: "CHOOSER_PWA_HANDSHAKE_RESULT",
        buildId: "build-a",
        requestId: "build-a:1",
        complete: true,
      }),
    ]);

    worker.setOffline(true);
    await expect(
      worker.dispatchFetch("/settings", "navigate"),
    ).resolves.toHaveProperty("url", `${ORIGIN}/settings/`);
    await expect(
      worker.dispatchFetch("/settings/", "navigate"),
    ).resolves.toHaveProperty("url", `${ORIGIN}/settings/`);
    await expect(
      worker.dispatchFetch("/legal/gpl-3.0.txt", "navigate"),
    ).resolves.toHaveProperty("url", `${ORIGIN}/legal/gpl-3.0.txt`);
    await expect(
      worker.dispatchFetch("/unknown", "navigate"),
    ).resolves.toHaveProperty("url", `${ORIGIN}/`);
    await expect(
      worker.dispatchFetch("/source/chooser-web-build-a.tar.gz", "navigate"),
    ).rejects.toThrow();
  });

  it("does not intercept cross-origin or non-GET requests", async () => {
    const worker = createWorker({ precacheUrls: ["/"] });
    await worker.dispatchLifecycle("install");
    await worker.dispatchLifecycle("activate");

    await expect(
      worker.dispatchFetch("https://cdn.example/font.woff2", "no-cors", "GET"),
    ).resolves.toBeUndefined();
    await expect(
      worker.dispatchFetch("/submit", "same-origin", "POST"),
    ).resolves.toBeUndefined();
  });
});

function createWorker({ precacheUrls, failingPath } = {}) {
  const listeners = new Map();
  const cacheMap = new Map();
  let offline = false;
  const clients = {
    claimed: false,
    claim: async () => {
      clients.claimed = true;
    },
  };
  const caches = {
    async open(name) {
      if (!cacheMap.has(name)) {
        cacheMap.set(name, new FakeCache());
      }
      return cacheMap.get(name);
    },
    async delete(name) {
      return cacheMap.delete(name);
    },
    async keys() {
      return [...cacheMap.keys()];
    },
    async match(input) {
      const pathname = requestPath(input);
      for (const cache of cacheMap.values()) {
        const found = await cache.match(pathname);
        if (found) {
          return found;
        }
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    clients,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const source = buildServiceWorkerSource({ buildId: "build-a", precacheUrls });
  const context = vm.createContext({
    Request,
    Response,
    URL,
    caches,
    fetch: async (input) => {
      const pathname = requestPath(input);
      if (offline || pathname === failingPath) {
        throw new Error(`offline: ${pathname}`);
      }
      return response(pathname);
    },
    self,
  });
  vm.runInContext(source, context);

  return {
    caches,
    clients,
    setOffline(value) {
      offline = value;
    },
    async dispatchLifecycle(type) {
      const waits = [];
      listeners.get(type)({
        waitUntil(value) {
          waits.push(Promise.resolve(value));
        },
      });
      await Promise.all(waits);
    },
    async dispatchMessage(data, target) {
      const waits = [];
      listeners.get("message")({
        data,
        ports: [],
        source: target,
        waitUntil(value) {
          waits.push(Promise.resolve(value));
        },
      });
      await Promise.all(waits);
    },
    async dispatchFetch(input, mode, method = "GET") {
      let responsePromise;
      listeners.get("fetch")({
        request: serviceRequest(input, method, mode),
        respondWith(value) {
          responsePromise = Promise.resolve(value);
        },
      });
      return responsePromise ? responsePromise : undefined;
    },
  };
}

class FakeCache {
  #entries = new Map();

  async put(input, value) {
    const clone = value.clone();
    Object.defineProperty(clone, "url", { value: value.url });
    this.#entries.set(requestPath(input), clone);
  }

  async match(input) {
    return this.#entries.get(requestPath(input));
  }
}

function request(input, method = "GET", mode = "same-origin") {
  const url = input.startsWith("http") ? input : `${ORIGIN}${input}`;
  return new Request(url, { method, mode });
}

function serviceRequest(input, method = "GET", mode = "same-origin") {
  const url = input.startsWith("http") ? input : `${ORIGIN}${input}`;
  return { method, mode, url };
}

function requestPath(input) {
  return new URL(
    typeof input === "string" && input.startsWith("/")
      ? `${ORIGIN}${input}`
      : typeof input === "string"
        ? input
        : input.url,
  ).pathname;
}

function response(pathname) {
  const value = new Response(pathname, { status: 200 });
  Object.defineProperty(value, "url", { value: `${ORIGIN}${pathname}` });
  return value;
}
