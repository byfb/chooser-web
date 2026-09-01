// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import {
  DISPLAY_MODE_QUERIES,
  createSettingsCapabilityModel,
  type SettingsCapabilityBrowser,
  type SettingsCapabilityDocument,
  type SettingsCapabilityMediaQuery,
} from "./settings-capability-model";

describe("settings capability model", () => {
  it("derives supported tab and vibration availability from the injected browser", () => {
    const browser = createBrowser({
      fullscreenEnabled: true,
      vibration: true,
    });
    const model = createSettingsCapabilityModel(browser.port);

    expect(model.getSnapshot()).toEqual({
      fullscreen: {
        supported: true,
        active: false,
        disabled: false,
        status: null,
        displayMode: "browser",
      },
      vibration: {
        supported: true,
        disabled: false,
        status: null,
      },
    });
  });

  it("reports unavailable capability states in an ordinary unsupported tab", () => {
    const browser = createBrowser({
      fullscreenEnabled: false,
      fullscreenMethods: false,
      vibration: false,
    });
    const model = createSettingsCapabilityModel(browser.port);

    expect(model.getSnapshot()).toEqual({
      fullscreen: {
        supported: false,
        active: false,
        disabled: true,
        status: "Unavailable",
        displayMode: "browser",
      },
      vibration: {
        supported: false,
        disabled: true,
        status: "Unavailable",
      },
    });
  });

  it.each([
    ["standalone", DISPLAY_MODE_QUERIES.standalone],
    ["fullscreen", DISPLAY_MODE_QUERIES.fullscreen],
  ] as const)(
    "reports installed %s display mode as active app mode",
    (displayMode, query) => {
      const browser = createBrowser({
        fullscreenEnabled: true,
        displayModes: new Set([query]),
      });
      const model = createSettingsCapabilityModel(browser.port);

      expect(model.getSnapshot().fullscreen).toEqual({
        supported: true,
        active: true,
        disabled: true,
        status: "App mode",
        displayMode,
      });
    },
  );

  it("tracks live fullscreen and display-mode changes once after start", () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    const model = createSettingsCapabilityModel(browser.port);
    const listener = vi.fn();
    const stop = model.start();
    model.start();
    model.subscribe(listener);

    expect(browser.document.addedFullscreenListeners).toBe(1);
    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.standalone)?.added,
    ).toBe(1);
    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.fullscreen)?.added,
    ).toBe(1);

    browser.document.fullscreenElement = {};
    browser.document.emitFullscreenChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().fullscreen.active).toBe(true);

    const standaloneQuery = browser.mediaQueries.get(
      DISPLAY_MODE_QUERIES.standalone,
    ) as HarnessMediaQuery;
    standaloneQuery.matches = true;
    standaloneQuery.emitChange();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(model.getSnapshot().fullscreen.status).toBe("App mode");

    stop();
    expect(browser.document.removedFullscreenListeners).toBe(1);
    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.standalone)?.removed,
    ).toBe(1);
    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.fullscreen)?.removed,
    ).toBe(1);

    browser.document.fullscreenElement = null;
    browser.document.emitFullscreenChange();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("requests fullscreen from the live inactive state", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    browser.document.documentElement.requestFullscreen = vi.fn(async () => {
      browser.document.fullscreenElement = browser.document.documentElement;
    });
    const model = createSettingsCapabilityModel(browser.port);

    const snapshot = await model.toggleFullscreen();

    expect(
      browser.document.documentElement.requestFullscreen,
    ).toHaveBeenCalledTimes(1);
    expect(browser.document.exitFullscreen).not.toHaveBeenCalled();
    expect(snapshot.fullscreen.active).toBe(true);
  });

  it("exits fullscreen from the live active state", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    browser.document.fullscreenElement = browser.document.documentElement;
    browser.document.exitFullscreen = vi.fn(async () => {
      browser.document.fullscreenElement = null;
    });
    const model = createSettingsCapabilityModel(browser.port);

    const snapshot = await model.toggleFullscreen();

    expect(browser.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(
      browser.document.documentElement.requestFullscreen,
    ).not.toHaveBeenCalled();
    expect(snapshot.fullscreen.active).toBe(false);
  });

  it("invokes native fullscreen methods with their DOM receivers", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    browser.document.documentElement.requestFullscreen = vi.fn(function (
      this: unknown,
    ) {
      expect(this).toBe(browser.document.documentElement);
      browser.document.fullscreenElement = browser.document.documentElement;
      return Promise.resolve();
    });
    browser.document.exitFullscreen = vi.fn(function (this: unknown) {
      expect(this).toBe(browser.document);
      browser.document.fullscreenElement = null;
      return Promise.resolve();
    });
    const model = createSettingsCapabilityModel(browser.port);

    await model.toggleFullscreen();
    await model.toggleFullscreen();

    expect(
      browser.document.documentElement.requestFullscreen,
    ).toHaveBeenCalledTimes(1);
    expect(browser.document.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("catches a denied request and preserves actual fullscreen truth", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    browser.document.documentElement.requestFullscreen = vi.fn(async () => {
      throw new Error("denied");
    });
    const model = createSettingsCapabilityModel(browser.port);

    await expect(model.toggleFullscreen()).resolves.toMatchObject({
      fullscreen: { active: false },
    });
  });

  it("catches a denied exit and preserves actual fullscreen truth", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    browser.document.fullscreenElement = browser.document.documentElement;
    browser.document.exitFullscreen = vi.fn(async () => {
      throw new Error("denied");
    });
    const model = createSettingsCapabilityModel(browser.port);

    await expect(model.toggleFullscreen()).resolves.toMatchObject({
      fullscreen: { active: true },
    });
  });

  it("does not call fullscreen methods when app mode or capability is unavailable", async () => {
    const unsupported = createBrowser({
      fullscreenEnabled: false,
      fullscreenMethods: false,
    });
    const unsupportedModel = createSettingsCapabilityModel(unsupported.port);
    await unsupportedModel.toggleFullscreen();
    expect(
      unsupported.document.documentElement.requestFullscreen,
    ).toBeUndefined();
    expect(unsupported.document.exitFullscreen).toBeUndefined();

    const installed = createBrowser({
      fullscreenEnabled: true,
      displayModes: new Set([DISPLAY_MODE_QUERIES.standalone]),
    });
    const installedModel = createSettingsCapabilityModel(installed.port);
    await installedModel.toggleFullscreen();
    expect(
      installed.document.documentElement.requestFullscreen,
    ).not.toHaveBeenCalled();
    expect(installed.document.exitFullscreen).not.toHaveBeenCalled();
  });

  it("uses legacy media-query listeners when modern listeners are absent", () => {
    const browser = createBrowser({
      fullscreenEnabled: true,
      legacyMediaListeners: true,
    });
    const model = createSettingsCapabilityModel(browser.port);
    const listener = vi.fn();
    const stop = model.start();
    model.subscribe(listener);

    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.standalone)?.legacyAdded,
    ).toBe(1);
    const fullscreenQuery = browser.mediaQueries.get(
      DISPLAY_MODE_QUERIES.fullscreen,
    ) as HarnessMediaQuery;
    fullscreenQuery.matches = true;
    fullscreenQuery.emitChange();
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    expect(
      browser.mediaQueries.get(DISPLAY_MODE_QUERIES.fullscreen)?.legacyRemoved,
    ).toBe(1);
  });

  it("supports a media query without listener APIs and ignores unchanged refreshes", () => {
    const browser = createBrowser({
      fullscreenEnabled: true,
      noMediaListeners: true,
    });
    const model = createSettingsCapabilityModel(browser.port);
    const listener = vi.fn();
    model.subscribe(listener);
    const stop = model.start();
    model.start();

    expect(listener).not.toHaveBeenCalled();
    stop();
    expect(browser.document.removedFullscreenListeners).toBe(1);
  });

  it("removes subscribers and safely no-ops if the live API disappears", async () => {
    const browser = createBrowser({ fullscreenEnabled: true });
    const model = createSettingsCapabilityModel(browser.port);
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    unsubscribe();

    const requestFullscreen =
      browser.document.documentElement.requestFullscreen;
    let requestReads = 0;
    Object.defineProperty(
      browser.document.documentElement,
      "requestFullscreen",
      {
        configurable: true,
        get() {
          requestReads += 1;
          return requestReads === 1 ? requestFullscreen : undefined;
        },
      },
    );
    await expect(model.toggleFullscreen()).resolves.toMatchObject({
      fullscreen: { supported: true, disabled: false },
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

interface BrowserHarness {
  readonly port: SettingsCapabilityBrowser;
  readonly document: HarnessDocument;
  readonly mediaQueries: Map<string, HarnessMediaQuery>;
}

interface HarnessDocument {
  fullscreenElement: unknown | null;
  readonly documentElement: {
    requestFullscreen?: ReturnType<typeof vi.fn>;
  };
  exitFullscreen?: ReturnType<typeof vi.fn>;
  addEventListener(type: "fullscreenchange", listener: () => void): void;
  removeEventListener(type: "fullscreenchange", listener: () => void): void;
  readonly addedFullscreenListeners: number;
  readonly removedFullscreenListeners: number;
  emitFullscreenChange(): void;
}

interface HarnessMediaQuery extends SettingsCapabilityMediaQuery {
  matches: boolean;
  readonly added: number;
  readonly removed: number;
  readonly legacyAdded: number;
  readonly legacyRemoved: number;
  emitChange(): void;
}

function createBrowser(options: {
  fullscreenEnabled: boolean;
  fullscreenMethods?: boolean;
  vibration?: boolean;
  displayModes?: Set<string>;
  legacyMediaListeners?: boolean;
  noMediaListeners?: boolean;
}): BrowserHarness {
  const fullscreenListeners = new Set<() => void>();
  let addedFullscreenListeners = 0;
  let removedFullscreenListeners = 0;
  const document = {
    fullscreenEnabled: options.fullscreenEnabled,
    fullscreenElement: null as unknown,
    documentElement: {
      requestFullscreen:
        options.fullscreenMethods === false
          ? undefined
          : vi.fn(async () => undefined),
    },
    exitFullscreen:
      options.fullscreenMethods === false
        ? undefined
        : vi.fn(async () => undefined),
    addEventListener(_type: "fullscreenchange", listener: () => void) {
      addedFullscreenListeners += 1;
      fullscreenListeners.add(listener);
    },
    removeEventListener(_type: "fullscreenchange", listener: () => void) {
      removedFullscreenListeners += 1;
      fullscreenListeners.delete(listener);
    },
    get addedFullscreenListeners() {
      return addedFullscreenListeners;
    },
    get removedFullscreenListeners() {
      return removedFullscreenListeners;
    },
    emitFullscreenChange() {
      fullscreenListeners.forEach((listener) => listener());
    },
  } as unknown as HarnessDocument;
  const mediaQueries = new Map<string, HarnessMediaQuery>();

  for (const query of [
    DISPLAY_MODE_QUERIES.standalone,
    DISPLAY_MODE_QUERIES.fullscreen,
  ]) {
    mediaQueries.set(
      query,
      createMediaQuery(
        options.displayModes?.has(query) ?? false,
        options.legacyMediaListeners ?? false,
        options.noMediaListeners ?? false,
      ),
    );
  }

  const port: SettingsCapabilityBrowser = {
    document: document as unknown as SettingsCapabilityDocument,
    navigator: options.vibration ? { vibrate: vi.fn(() => true) } : {},
    matchMedia(query) {
      return mediaQueries.get(query) as HarnessMediaQuery;
    },
  };

  return {
    port,
    document,
    mediaQueries,
  };
}

function createMediaQuery(
  initialMatches: boolean,
  legacy: boolean,
  noListeners: boolean,
): HarnessMediaQuery {
  const modernListeners = new Set<() => void>();
  const legacyListeners = new Set<() => void>();
  let added = 0;
  let removed = 0;
  let legacyAdded = 0;
  let legacyRemoved = 0;
  return {
    matches: initialMatches,
    ...(noListeners || legacy
      ? {}
      : {
          addEventListener(_type: "change", listener: () => void) {
            added += 1;
            modernListeners.add(listener);
          },
          removeEventListener(_type: "change", listener: () => void) {
            removed += 1;
            modernListeners.delete(listener);
          },
        }),
    ...(noListeners || !legacy
      ? {}
      : {
          addListener(listener: () => void) {
            legacyAdded += 1;
            legacyListeners.add(listener);
          },
          removeListener(listener: () => void) {
            legacyRemoved += 1;
            legacyListeners.delete(listener);
          },
        }),
    get added() {
      return added;
    },
    get removed() {
      return removed;
    },
    get legacyAdded() {
      return legacyAdded;
    },
    get legacyRemoved() {
      return legacyRemoved;
    },
    emitChange() {
      modernListeners.forEach((listener) => listener());
      legacyListeners.forEach((listener) => listener());
    },
  } as HarnessMediaQuery;
}
