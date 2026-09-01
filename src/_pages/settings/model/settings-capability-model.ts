// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

export const DISPLAY_MODE_QUERIES = {
  standalone: "(display-mode: standalone)",
  fullscreen: "(display-mode: fullscreen)",
} as const;

export type SettingsCapabilityStatus = "App mode" | "Unavailable";
export type SettingsDisplayMode = "browser" | "standalone" | "fullscreen";

export interface SettingsFullscreenElement {
  requestFullscreen?: () => Promise<void>;
}

export type SettingsCapabilityListener = () => void;

export interface SettingsCapabilityDocument {
  readonly fullscreenEnabled?: boolean;
  readonly fullscreenElement: unknown | null;
  readonly documentElement: SettingsFullscreenElement;
  readonly exitFullscreen?: () => Promise<void>;
  addEventListener(
    type: "fullscreenchange",
    listener: SettingsCapabilityListener,
  ): void;
  removeEventListener(
    type: "fullscreenchange",
    listener: SettingsCapabilityListener,
  ): void;
}

export interface SettingsCapabilityMediaQuery {
  readonly matches: boolean;
  addEventListener?: (
    type: "change",
    listener: SettingsCapabilityListener,
  ) => void;
  removeEventListener?: (
    type: "change",
    listener: SettingsCapabilityListener,
  ) => void;
  addListener?: (listener: SettingsCapabilityListener) => void;
  removeListener?: (listener: SettingsCapabilityListener) => void;
}

export interface SettingsCapabilityNavigator {
  readonly vibrate?: (pattern: number | number[]) => boolean;
}

export interface SettingsCapabilityBrowser {
  readonly document: SettingsCapabilityDocument;
  readonly navigator: SettingsCapabilityNavigator;
  matchMedia(query: string): SettingsCapabilityMediaQuery;
}

export interface SettingsFullscreenCapability {
  readonly supported: boolean;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly status: SettingsCapabilityStatus | null;
  readonly displayMode: SettingsDisplayMode;
}

export interface SettingsVibrationCapability {
  readonly supported: boolean;
  readonly disabled: boolean;
  readonly status: SettingsCapabilityStatus | null;
}

export interface SettingsCapabilitySnapshot {
  readonly fullscreen: Readonly<SettingsFullscreenCapability>;
  readonly vibration: Readonly<SettingsVibrationCapability>;
}

export interface SettingsCapabilityModel {
  getSnapshot(): SettingsCapabilitySnapshot;
  subscribe(listener: SettingsCapabilityListener): () => void;
  start(): () => void;
  toggleFullscreen(): Promise<SettingsCapabilitySnapshot>;
}

export function createSettingsCapabilityModel(
  browser: SettingsCapabilityBrowser,
): SettingsCapabilityModel {
  const standaloneQuery = browser.matchMedia(DISPLAY_MODE_QUERIES.standalone);
  const fullscreenQuery = browser.matchMedia(DISPLAY_MODE_QUERIES.fullscreen);
  const listeners = new Set<SettingsCapabilityListener>();
  const onCapabilityChange = () => {
    refresh();
  };
  let snapshot = createSnapshot();
  let stop: (() => void) | undefined;

  return {
    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (stop) {
        return stop;
      }

      browser.document.addEventListener("fullscreenchange", onCapabilityChange);
      const stopStandalone = listenToMediaQuery(
        standaloneQuery,
        onCapabilityChange,
      );
      const stopFullscreen = listenToMediaQuery(
        fullscreenQuery,
        onCapabilityChange,
      );
      stop = () => {
        browser.document.removeEventListener(
          "fullscreenchange",
          onCapabilityChange,
        );
        stopStandalone();
        stopFullscreen();
        stop = undefined;
      };
      refresh();
      return stop;
    },

    async toggleFullscreen() {
      const current = refresh();
      if (current.fullscreen.disabled) {
        return current;
      }

      const requestFullscreen =
        browser.document.documentElement.requestFullscreen;
      const exitFullscreen = browser.document.exitFullscreen;
      if (
        typeof requestFullscreen !== "function" ||
        typeof exitFullscreen !== "function"
      ) {
        return current;
      }

      try {
        if (browser.document.fullscreenElement !== null) {
          await exitFullscreen.call(browser.document);
        } else {
          await requestFullscreen.call(browser.document.documentElement);
        }
      } catch {
        // Fullscreen requests are user-agent controlled. The next snapshot
        // intentionally reads the actual element after a denial or exit.
      }
      return refresh();
    },
  };

  function createSnapshot(): SettingsCapabilitySnapshot {
    const displayMode = readDisplayMode();
    const installed = displayMode !== "browser";
    const supported = isFullscreenSupported();
    return Object.freeze({
      fullscreen: Object.freeze({
        supported,
        active:
          installed ||
          (supported && browser.document.fullscreenElement !== null),
        disabled: installed || !supported,
        status: installed ? "App mode" : supported ? null : "Unavailable",
        displayMode,
      }),
      vibration: createVibrationCapability(),
    });
  }

  function refresh(): SettingsCapabilitySnapshot {
    const next = createSnapshot();
    if (!snapshotsEqual(snapshot, next)) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    }
    return snapshot;
  }

  function readDisplayMode(): SettingsDisplayMode {
    if (fullscreenQuery.matches) {
      return "fullscreen";
    }
    if (standaloneQuery.matches) {
      return "standalone";
    }
    return "browser";
  }

  function isFullscreenSupported() {
    return (
      browser.document.fullscreenEnabled === true &&
      typeof browser.document.documentElement.requestFullscreen ===
        "function" &&
      typeof browser.document.exitFullscreen === "function"
    );
  }

  function createVibrationCapability(): Readonly<SettingsVibrationCapability> {
    const supported = typeof browser.navigator.vibrate === "function";
    return Object.freeze({
      supported,
      disabled: !supported,
      status: supported ? null : "Unavailable",
    });
  }
}

function listenToMediaQuery(
  query: SettingsCapabilityMediaQuery,
  listener: SettingsCapabilityListener,
): () => void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => {
      query.removeEventListener?.("change", listener);
    };
  }

  if (typeof query.addListener === "function") {
    query.addListener(listener);
    return () => {
      query.removeListener?.(listener);
    };
  }

  return () => undefined;
}

function snapshotsEqual(
  left: SettingsCapabilitySnapshot,
  right: SettingsCapabilitySnapshot,
) {
  return (
    left.fullscreen.supported === right.fullscreen.supported &&
    left.fullscreen.active === right.fullscreen.active &&
    left.fullscreen.disabled === right.fullscreen.disabled &&
    left.fullscreen.status === right.fullscreen.status &&
    left.fullscreen.displayMode === right.fullscreen.displayMode &&
    left.vibration.supported === right.vibration.supported &&
    left.vibration.disabled === right.vibration.disabled &&
    left.vibration.status === right.vibration.status
  );
}
