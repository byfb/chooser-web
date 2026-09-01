// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import {
  CHOOSER_PWA_HANDSHAKE_RESPONSE,
  createChooserPwaRuntime,
  type ChooserPwaBrowserPort,
  type ChooserPwaMessage,
  type ChooserPwaMessageEvent,
  type ChooserServiceWorker,
  type ChooserServiceWorkerContainer,
  type ChooserServiceWorkerRegistration,
} from "./index";

describe("Chooser PWA runtime", () => {
  it("registers the stable root worker and becomes ready after a matching complete handshake", async () => {
    const browser = createBrowser();
    const runtime = createChooserPwaRuntime(browser.port, "build-a");
    const listener = vi.fn();

    runtime.subscribe(listener);
    const stop = runtime.start();
    await settle();

    expect(browser.registerCalls).toEqual([
      { scriptUrl: "/sw.js", scope: "/" },
    ]);
    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });
    expect(browser.worker.messages).toHaveLength(1);

    const request = readMessage(browser.worker.messages[0]);
    browser.emitMessage({
      type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
      requestId: request.requestId,
      buildId: "build-a",
      complete: true,
    });
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Ready" });
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
  });

  it("reports Unavailable when service workers are unsupported", () => {
    const browser = createBrowser({ supported: false });
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();

    expect(runtime.getSnapshot()).toEqual({ offline: "Unavailable" });
    expect(browser.registerCalls).toHaveLength(0);
  });

  it("reports Unavailable when registration fails", async () => {
    const browser = createBrowser({ registrationFailure: true });
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Unavailable" });
  });

  it("retries the complete-cache handshake after the page becomes controlled", async () => {
    const browser = createBrowser({ controlled: false });
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });
    expect(browser.worker.messages).toHaveLength(0);

    browser.setControlled(true);
    browser.emitControllerChange();
    await settle();

    expect(browser.registerCalls).toHaveLength(1);
    expect(browser.worker.messages).toHaveLength(1);
    const request = readMessage(browser.worker.messages[0]);
    browser.emitMessage({
      type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
      requestId: request.requestId,
      buildId: "build-a",
      complete: true,
    });
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Ready" });
  });

  it("waits when the page is controlled by a worker other than the active registration", async () => {
    const browser = createBrowser({ controllerMismatch: true });
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });
    expect(browser.worker.messages).toHaveLength(0);

    browser.setControlled(true);
    browser.emitControllerChange();
    await settle();

    expect(browser.worker.messages).toHaveLength(1);
  });

  it("verifies the active worker even when a replacement is waiting", async () => {
    const browser = createBrowser({ waitingWorker: true });
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();
    await settle();

    const request = readMessage(browser.worker.messages[0]);
    browser.emitMessage({
      type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
      requestId: request.requestId,
      buildId: "build-a",
      complete: true,
    });
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Ready" });
  });

  it.each([
    ["a mismatched build identity", { buildId: "build-b", complete: true }],
    ["an incomplete cache", { buildId: "build-a", complete: false }],
  ])(
    "reports Unavailable after %s is acknowledged",
    async (_reason, result) => {
      const browser = createBrowser();
      const runtime = createChooserPwaRuntime(browser.port, "build-a");

      runtime.start();
      await settle();
      const request = readMessage(browser.worker.messages[0]);
      browser.emitMessage({
        type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
        requestId: request.requestId,
        ...result,
      });
      await settle();

      expect(runtime.getSnapshot()).toEqual({ offline: "Unavailable" });
    },
  );

  it("reports Unavailable when the complete-cache handshake times out", async () => {
    const browser = createBrowser();
    const runtime = createChooserPwaRuntime(browser.port, "build-a", {
      handshakeTimeoutMs: 25,
    });

    runtime.start();
    await settle();
    browser.runTimers();
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Unavailable" });
  });

  it("ignores stale handshake responses after a controller change", async () => {
    const browser = createBrowser();
    const runtime = createChooserPwaRuntime(browser.port, "build-a");

    runtime.start();
    await settle();
    const firstRequest = readMessage(browser.worker.messages[0]);

    browser.emitControllerChange();
    await settle();
    const secondRequest = readMessage(browser.worker.messages[1]);
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    browser.emitMessage({
      type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
      requestId: firstRequest.requestId,
      buildId: "build-a",
      complete: true,
    });
    await settle();
    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });

    browser.emitMessage({
      type: CHOOSER_PWA_HANDSHAKE_RESPONSE,
      requestId: secondRequest.requestId,
      buildId: "build-a",
      complete: true,
    });
    await settle();
    expect(runtime.getSnapshot()).toEqual({ offline: "Ready" });
  });

  it("does not become ready from registration alone or after it is stopped", async () => {
    const browser = createBrowser();
    const runtime = createChooserPwaRuntime(browser.port, "build-a", {
      handshakeTimeoutMs: 25,
    });

    const stop = runtime.start();
    await settle();
    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });

    stop();
    browser.runTimers();
    await settle();

    expect(runtime.getSnapshot()).toEqual({ offline: "Preparing" });
    expect(browser.listenerCounts).toEqual({
      controllerchange: 0,
      message: 0,
    });
  });
});

function readMessage(
  message: unknown,
): Extract<ChooserPwaMessage, { type: "CHOOSER_PWA_HANDSHAKE" }> {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "CHOOSER_PWA_HANDSHAKE" ||
    !("requestId" in message) ||
    typeof message.requestId !== "string"
  ) {
    throw new Error("Expected a Chooser PWA handshake request");
  }

  return message as Extract<
    ChooserPwaMessage,
    { type: "CHOOSER_PWA_HANDSHAKE" }
  >;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function createBrowser(
  options: {
    controlled?: boolean;
    controllerMismatch?: boolean;
    registrationFailure?: boolean;
    supported?: boolean;
    waitingWorker?: boolean;
  } = {},
) {
  const controllerChangeListeners = new Set<() => void>();
  const messageListeners = new Set<(event: ChooserPwaMessageEvent) => void>();
  const registerCalls: Array<{ scriptUrl: string; scope: string }> = [];
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const worker: ChooserServiceWorker & { messages: unknown[] } = {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
  const replacementWorker: ChooserServiceWorker & { messages: unknown[] } = {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
  const activeWorker: ChooserServiceWorker | null = worker;
  const registration: ChooserServiceWorkerRegistration = {
    get active() {
      return activeWorker;
    },
    installing: null,
    waiting: options.waitingWorker ? replacementWorker : null,
    update: vi.fn(async () => undefined),
  };
  let controller: ChooserServiceWorker | null =
    options.controlled === false
      ? null
      : options.controllerMismatch
        ? replacementWorker
        : worker;
  const container: ChooserServiceWorkerContainer = {
    get controller() {
      return controller;
    },
    register: vi.fn(async (scriptUrl, registerOptions) => {
      registerCalls.push({
        scriptUrl,
        scope: registerOptions?.scope ?? "",
      });
      if (options.registrationFailure) {
        throw new Error("registration failed");
      }
      return registration;
    }),
    addEventListener(type, listener) {
      if (type === "controllerchange") {
        controllerChangeListeners.add(listener as () => void);
      } else {
        messageListeners.add(
          listener as (event: ChooserPwaMessageEvent) => void,
        );
      }
    },
    removeEventListener(type, listener) {
      if (type === "controllerchange") {
        controllerChangeListeners.delete(listener as () => void);
      } else {
        messageListeners.delete(
          listener as (event: ChooserPwaMessageEvent) => void,
        );
      }
    },
  };
  const port: ChooserPwaBrowserPort = {
    ...(options.supported === false ? {} : { serviceWorker: container }),
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };

  return {
    port,
    worker,
    registerCalls,
    emitMessage(data: unknown) {
      messageListeners.forEach((listener) => listener({ data }));
    },
    emitControllerChange() {
      controllerChangeListeners.forEach((listener) => listener());
    },
    setControlled(value: boolean) {
      controller = value ? worker : null;
    },
    get listenerCounts() {
      return {
        controllerchange: controllerChangeListeners.size,
        message: messageListeners.size,
      };
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}
