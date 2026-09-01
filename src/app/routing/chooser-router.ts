// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { APP_ROUTES, type AppRoute } from "@/shared/config";

const STATE_KEY = "__chooser";

type Listener = () => void;

export interface ChooserBrowserPort {
  readonly location: {
    readonly pathname: string;
  };
  readonly history: {
    readonly state: unknown;
    back(): void;
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: Listener): void;
  removeEventListener(type: "popstate", listener: Listener): void;
}

export interface ChooserRouter {
  back(): void;
  getSnapshot(): AppRoute;
  navigate(route: AppRoute): void;
  start(): () => void;
  subscribe(listener: Listener): () => void;
}

export function createChooserRouter(
  browser: ChooserBrowserPort,
): ChooserRouter {
  const listeners = new Set<Listener>();
  let currentRoute = resolveRoute(browser.location.pathname);
  let currentDepth = readDepth(browser.history.state) ?? 0;
  let started = false;

  const notify = () => listeners.forEach((listener) => listener());

  const synchronize = () => {
    const route = resolveRoute(browser.location.pathname);
    const stateDepth = readDepth(browser.history.state);
    const isKnownPath = canonicalPath(browser.location.pathname) === route;
    const depth = isKnownPath ? (stateDepth ?? 0) : 0;
    const shouldReplace =
      browser.location.pathname !== route || stateDepth === null;
    const routeChanged = route !== currentRoute || depth !== currentDepth;

    currentRoute = route;
    currentDepth = depth;

    if (shouldReplace) {
      browser.history.replaceState(
        withChooserState(browser.history.state, depth),
        "",
        route,
      );
    }
    if (shouldReplace || routeChanged) {
      notify();
    }
  };

  const onPopState = () => synchronize();

  return {
    back() {
      if (currentDepth > 0) {
        browser.history.back();
        return;
      }

      const fallback = backFallback(currentRoute);
      if (fallback === currentRoute) {
        return;
      }

      currentRoute = fallback;
      currentDepth = 0;
      browser.history.replaceState(
        withChooserState(browser.history.state, 0),
        "",
        fallback,
      );
      notify();
    },

    getSnapshot() {
      return currentRoute;
    },

    navigate(route) {
      if (route === currentRoute) {
        return;
      }

      currentDepth += 1;
      currentRoute = route;
      browser.history.pushState(
        withChooserState(browser.history.state, currentDepth),
        "",
        route,
      );
      notify();
    },

    start() {
      if (started) {
        return () => undefined;
      }

      started = true;
      browser.addEventListener("popstate", onPopState);
      synchronize();

      return () => {
        if (!started) {
          return;
        }
        started = false;
        browser.removeEventListener("popstate", onPopState);
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function resolveRoute(pathname: string): AppRoute {
  const canonical = canonicalPath(pathname);

  if (canonical === APP_ROUTES.settings) {
    return APP_ROUTES.settings;
  }
  if (canonical === APP_ROUTES.legal) {
    return APP_ROUTES.legal;
  }
  return APP_ROUTES.chooser;
}

function canonicalPath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function backFallback(route: AppRoute): AppRoute {
  if (route === APP_ROUTES.legal) {
    return APP_ROUTES.settings;
  }
  return APP_ROUTES.chooser;
}

function readDepth(state: unknown) {
  if (!isRecord(state)) {
    return null;
  }
  const chooserState = state[STATE_KEY];
  if (!isRecord(chooserState)) {
    return null;
  }
  const depth = chooserState.depth;
  return typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0
    ? depth
    : null;
}

function withChooserState(state: unknown, depth: number) {
  return {
    ...(isRecord(state) ? state : {}),
    [STATE_KEY]: { depth },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
