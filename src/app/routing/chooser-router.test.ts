// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import { APP_ROUTES } from "@/shared/config";

import { createChooserRouter, type ChooserBrowserPort } from "./chooser-router";

describe("Chooser browser router", () => {
  it("replaces an unknown direct entry with the chooser route", () => {
    const browser = createBrowser("/missing");
    const router = createChooserRouter(browser.port);

    const stop = router.start();

    expect(router.getSnapshot()).toBe(APP_ROUTES.chooser);
    expect(browser.current()).toMatchObject({
      pathname: APP_ROUTES.chooser,
      state: { __chooser: { depth: 0 } },
    });
    expect(browser.replaces).toBe(1);
    stop();
  });

  it.each([
    [APP_ROUTES.settings, APP_ROUTES.chooser],
    [APP_ROUTES.legal, APP_ROUTES.settings],
  ])(
    "uses a safe Back fallback for a direct entry at %s",
    (entry, fallback) => {
      const browser = createBrowser(entry);
      const router = createChooserRouter(browser.port);
      router.start();

      router.back();

      expect(router.getSnapshot()).toBe(fallback);
      expect(browser.current().pathname).toBe(fallback);
      expect(browser.backs).toBe(0);
      expect(browser.replaces).toBe(2);
    },
  );

  it("uses browser history for routes opened inside the app", () => {
    const browser = createBrowser(APP_ROUTES.chooser);
    const router = createChooserRouter(browser.port);
    router.start();
    router.navigate(APP_ROUTES.settings);
    router.navigate(APP_ROUTES.legal);

    router.back();

    expect(browser.backs).toBe(1);
    expect(router.getSnapshot()).toBe(APP_ROUTES.settings);
    expect(browser.current().pathname).toBe(APP_ROUTES.settings);
  });

  it("canonicalizes trailing slashes and notifies subscribers once", () => {
    const browser = createBrowser("/settings/");
    const router = createChooserRouter(browser.port);
    const subscriber = vi.fn();
    router.subscribe(subscriber);

    router.start();

    expect(router.getSnapshot()).toBe(APP_ROUTES.settings);
    expect(browser.current().pathname).toBe(APP_ROUTES.settings);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it("recovers an unknown popstate without emitting twice", () => {
    const browser = createBrowser(APP_ROUTES.chooser);
    const router = createChooserRouter(browser.port);
    const subscriber = vi.fn();
    router.subscribe(subscriber);
    router.start();
    subscriber.mockClear();

    browser.popTo("/outside", null);

    expect(router.getSnapshot()).toBe(APP_ROUTES.chooser);
    expect(browser.current().pathname).toBe(APP_ROUTES.chooser);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it("keeps start idempotent and ignores same-route navigation", () => {
    const browser = createBrowser(APP_ROUTES.chooser);
    const router = createChooserRouter(browser.port);

    const stop = router.start();
    const stopDuplicate = router.start();
    router.navigate(APP_ROUTES.chooser);

    expect(browser.listenerCount).toBe(1);
    expect(browser.pushes).toBe(0);
    stopDuplicate();
    expect(browser.listenerCount).toBe(1);
    stop();
    expect(browser.listenerCount).toBe(0);
  });
});

function createBrowser(initialPathname: string) {
  type Entry = { pathname: string; state: unknown };
  const entries: Entry[] = [{ pathname: initialPathname, state: null }];
  const listeners = new Set<() => void>();
  let index = 0;
  let backs = 0;
  let pushes = 0;
  let replaces = 0;

  const currentEntry = () => {
    const entry = entries[index];
    if (!entry) {
      throw new Error("Fake browser history has no current entry");
    }
    return entry;
  };

  const port: ChooserBrowserPort = {
    location: {
      get pathname() {
        return currentEntry().pathname;
      },
    },
    history: {
      get state() {
        return currentEntry().state;
      },
      back() {
        backs += 1;
        if (index > 0) {
          index -= 1;
          listeners.forEach((listener) => listener());
        }
      },
      pushState(state, _unused, url) {
        pushes += 1;
        entries.splice(index + 1);
        entries.push({ pathname: String(url), state });
        index += 1;
      },
      replaceState(state, _unused, url) {
        replaces += 1;
        entries[index] = { pathname: String(url), state };
      },
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  return {
    port,
    current: currentEntry,
    popTo(pathname: string, state: unknown) {
      entries.splice(index + 1);
      entries.push({ pathname, state });
      index += 1;
      listeners.forEach((listener) => listener());
    },
    get backs() {
      return backs;
    },
    get listenerCount() {
      return listeners.size;
    },
    get pushes() {
      return pushes;
    },
    get replaces() {
      return replaces;
    },
  };
}
