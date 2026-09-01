// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

export const CHOOSER_PWA_SERVICE_WORKER_URL = "/sw.js" as const;
export const CHOOSER_PWA_SERVICE_WORKER_SCOPE = "/" as const;
export const CHOOSER_PWA_HANDSHAKE_REQUEST = "CHOOSER_PWA_HANDSHAKE" as const;
export const CHOOSER_PWA_HANDSHAKE_RESPONSE =
  "CHOOSER_PWA_HANDSHAKE_RESULT" as const;
export const CHOOSER_PWA_FOREGROUND_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type OfflineStatus = "Preparing" | "Ready" | "Unavailable";
export type ChooserPwaVisibilityState = "hidden" | "visible";

export interface ChooserPwaSnapshot {
  readonly offline: OfflineStatus;
}

export interface ChooserPwaHandshakeRequest {
  readonly type: typeof CHOOSER_PWA_HANDSHAKE_REQUEST;
  readonly buildId: string;
  readonly requestId: string;
}

export interface ChooserPwaHandshakeResponse {
  readonly type: typeof CHOOSER_PWA_HANDSHAKE_RESPONSE;
  readonly buildId: string;
  readonly requestId: string;
  readonly complete: boolean;
}

export type ChooserPwaMessage =
  ChooserPwaHandshakeRequest | ChooserPwaHandshakeResponse;

export interface ChooserServiceWorker {
  readonly state?: string;
  postMessage(message: ChooserPwaHandshakeRequest): void;
}

export interface ChooserServiceWorkerRegistration {
  readonly active: ChooserServiceWorker | null;
  readonly installing: ChooserServiceWorker | null;
  readonly waiting: ChooserServiceWorker | null;
  update(): Promise<unknown>;
}

export interface ChooserPwaMessageEvent {
  readonly data: unknown;
}

export interface ChooserServiceWorkerContainer {
  readonly controller: ChooserServiceWorker | null;
  register(
    scriptUrl: string,
    options?: { readonly scope?: string },
  ): Promise<ChooserServiceWorkerRegistration>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: ChooserPwaMessageEvent) => void,
  ): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: ChooserPwaMessageEvent) => void,
  ): void;
}

export interface ChooserPwaBrowserPort {
  readonly serviceWorker?: ChooserServiceWorkerContainer;
  readonly setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly visibilityState?: ChooserPwaVisibilityState;
  readonly now?: () => number;
  addEventListener?(type: "visibilitychange", listener: () => void): void;
  removeEventListener?(type: "visibilitychange", listener: () => void): void;
}

export interface ChooserPwaRuntime {
  getSnapshot(): ChooserPwaSnapshot;
  start(): () => void;
  subscribe(listener: () => void): () => void;
}

export interface ChooserPwaRuntimeOptions {
  readonly handshakeTimeoutMs?: number;
}

const INITIAL_SNAPSHOT: ChooserPwaSnapshot = Object.freeze({
  offline: "Preparing",
});
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export function createChooserPwaRuntime(
  browser: ChooserPwaBrowserPort,
  buildId: string,
  options: ChooserPwaRuntimeOptions = {},
): ChooserPwaRuntime {
  const listeners = new Set<() => void>();
  const serviceWorker = browser.serviceWorker;
  const scheduleTimeout =
    browser.setTimeout ??
    ((callback: () => void, timeoutMs: number) =>
      globalThis.setTimeout(callback, timeoutMs));
  const cancelTimeout =
    browser.clearTimeout ??
    ((handle: unknown) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ));
  const handshakeTimeoutMs = normalizeTimeout(options.handshakeTimeoutMs);
  const readNow = browser.now ?? (() => globalThis.performance?.now() ?? 0);

  let snapshot = INITIAL_SNAPSHOT;
  let stop: (() => void) | undefined;
  let registration: ChooserServiceWorkerRegistration | undefined;
  let registrationRequest: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  let requestSequence = 0;
  let pendingHandshake: PendingHandshake | undefined;
  let lastUpdateCheckAt: number | undefined;
  let previousVisibilityState: ChooserPwaVisibilityState = "visible";

  const notify = () => listeners.forEach((listener) => listener());

  const setOfflineStatus = (offline: OfflineStatus) => {
    if (snapshot.offline === offline) {
      return;
    }

    snapshot = Object.freeze({ offline });
    notify();
  };

  const onMessage = (event: ChooserPwaMessageEvent) => {
    const pending = pendingHandshake;
    if (!pending || !isHandshakeResponse(event.data)) {
      return;
    }

    if (event.data.requestId !== pending.requestId) {
      return;
    }

    pendingHandshake = undefined;
    cancelTimeout(pending.timeoutHandle);
    pending.resolve(
      event.data.buildId === buildId && event.data.complete === true,
    );
  };

  const onControllerChange = () => {
    if (!stop || !serviceWorker) {
      return;
    }

    lifecycleGeneration += 1;
    cancelPendingHandshake();
    setOfflineStatus("Preparing");
    if (registration) {
      void verifyRegistration(registration, lifecycleGeneration);
      return;
    }

    void registerAndVerify();
  };

  const onVisibilityChange = () => {
    if (!stop || !registration) {
      return;
    }

    const visibilityState = browser.visibilityState ?? "visible";
    const becameVisible =
      previousVisibilityState === "hidden" && visibilityState === "visible";
    previousVisibilityState = visibilityState;
    if (!becameVisible) {
      return;
    }

    const now = readNow();
    if (
      lastUpdateCheckAt === undefined ||
      now - lastUpdateCheckAt < CHOOSER_PWA_FOREGROUND_UPDATE_INTERVAL_MS
    ) {
      return;
    }

    lastUpdateCheckAt = now;
    try {
      void Promise.resolve(registration.update()).catch(() => undefined);
    } catch {
      // Update checks are opportunistic and must never affect the app.
    }
  };

  async function registerAndVerify() {
    if (!serviceWorker || registrationRequest) {
      return registrationRequest;
    }

    const generation = ++lifecycleGeneration;
    setOfflineStatus("Preparing");
    lastUpdateCheckAt = readNow();
    let registrationResult: Promise<ChooserServiceWorkerRegistration>;
    try {
      registrationResult = serviceWorker.register(
        CHOOSER_PWA_SERVICE_WORKER_URL,
        {
          scope: CHOOSER_PWA_SERVICE_WORKER_SCOPE,
        },
      );
    } catch {
      if (stop && generation === lifecycleGeneration) {
        setOfflineStatus("Unavailable");
      }
      return;
    }

    const request = registrationResult
      .then(async (nextRegistration) => {
        if (!stop || generation !== lifecycleGeneration) {
          return;
        }

        registration = nextRegistration;
        await verifyRegistration(nextRegistration, generation);
      })
      .catch(() => {
        if (stop && generation === lifecycleGeneration) {
          setOfflineStatus("Unavailable");
        }
      })
      .finally(() => {
        if (registrationRequest === request) {
          registrationRequest = undefined;
        }
      });
    registrationRequest = request;
    return request;
  }

  async function verifyRegistration(
    nextRegistration: ChooserServiceWorkerRegistration,
    generation: number,
  ) {
    if (!stop || generation !== lifecycleGeneration) {
      return;
    }

    const controller = serviceWorker?.controller;
    const active = nextRegistration.active;
    if (
      !controller ||
      !active ||
      active !== controller ||
      (active.state !== undefined && active.state !== "activated")
    ) {
      setOfflineStatus("Preparing");
      return;
    }

    const requestId = `${buildId}:${++requestSequence}`;
    const complete = await requestHandshake(controller, requestId);
    if (!stop || generation !== lifecycleGeneration) {
      return;
    }

    setOfflineStatus(complete ? "Ready" : "Unavailable");
  }

  function requestHandshake(
    controller: ChooserServiceWorker,
    requestId: string,
  ): Promise<boolean> {
    cancelPendingHandshake();

    return new Promise((resolve) => {
      const pending: PendingHandshake = {
        requestId,
        resolve,
        timeoutHandle: undefined,
      };
      pendingHandshake = pending;
      pending.timeoutHandle = scheduleTimeout(() => {
        if (pendingHandshake !== pending) {
          return;
        }

        pendingHandshake = undefined;
        pending.resolve(false);
      }, handshakeTimeoutMs);

      try {
        controller.postMessage({
          type: CHOOSER_PWA_HANDSHAKE_REQUEST,
          buildId,
          requestId,
        });
      } catch {
        if (pendingHandshake === pending) {
          pendingHandshake = undefined;
          cancelTimeout(pending.timeoutHandle);
          resolve(false);
        }
      }
    });
  }

  function cancelPendingHandshake() {
    const pending = pendingHandshake;
    if (!pending) {
      return;
    }

    pendingHandshake = undefined;
    cancelTimeout(pending.timeoutHandle);
    pending.resolve(false);
  }

  return {
    getSnapshot() {
      return snapshot;
    },

    start() {
      if (stop) {
        return stop;
      }

      if (!serviceWorker) {
        setOfflineStatus("Unavailable");
        stop = () => {
          stop = undefined;
        };
        return stop;
      }

      const cleanup = () => {
        if (!stop) {
          return;
        }

        stop = undefined;
        lifecycleGeneration += 1;
        cancelPendingHandshake();
        serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange,
        );
        serviceWorker.removeEventListener("message", onMessage);
        browser.removeEventListener?.("visibilitychange", onVisibilityChange);
      };

      stop = cleanup;
      previousVisibilityState = browser.visibilityState ?? "visible";
      serviceWorker.addEventListener("controllerchange", onControllerChange);
      serviceWorker.addEventListener("message", onMessage);
      browser.addEventListener?.("visibilitychange", onVisibilityChange);
      void registerAndVerify();
      return cleanup;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface PendingHandshake {
  readonly requestId: string;
  readonly resolve: (complete: boolean) => void;
  timeoutHandle: unknown;
}

function isHandshakeResponse(
  value: unknown,
): value is ChooserPwaHandshakeResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === CHOOSER_PWA_HANDSHAKE_RESPONSE &&
    typeof value.buildId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.complete === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimeout(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}
