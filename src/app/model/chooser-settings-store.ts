// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChooserSettings, SelectionMode } from "@/_pages/chooser";

export type { ChooserSettings, SelectionMode };

export const CHOOSER_SETTINGS_STORAGE_KEY = "chooser.settings";

export const CHOOSER_SETTINGS_CONSTRAINTS = {
  topPaddingPx: { minimum: 0, maximum: 50, step: 5 },
  circleSizePercent: { minimum: 50, maximum: 150, step: 10 },
  selectionDelayMs: { minimum: 0, maximum: 5000, step: 500 },
  circleLifetimeMs: { minimum: 0, maximum: 3000, step: 500 },
} as const;

export type SettingsPersistence = "saved" | "not-saved";

export interface ChooserSettingsSnapshot {
  readonly settings: Readonly<ChooserSettings>;
  readonly persistence: SettingsPersistence;
}

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChooserSettingsStore {
  getSnapshot(): ChooserSettingsSnapshot;
  load(): ChooserSettingsSnapshot;
  reset(): ChooserSettingsSnapshot;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<ChooserSettings>): ChooserSettingsSnapshot;
}

export const DEFAULT_CHOOSER_SETTINGS: Readonly<ChooserSettings> =
  Object.freeze({
    selectionMode: "single",
    selectionCount: 1,
    soundEnabled: true,
    vibrationEnabled: true,
    topPaddingPx: 0,
    circleSizePercent: 100,
    singleDelayMs: 3000,
    groupDelayMs: 3000,
    orderDelayMs: 3000,
    singleLifetimeMs: 1000,
    groupLifetimeMs: 1000,
    orderLifetimeMs: 1500,
  });

const initialSnapshot: ChooserSettingsSnapshot = Object.freeze({
  settings: DEFAULT_CHOOSER_SETTINGS,
  persistence: "saved" as const,
});

export function createChooserSettingsStore(
  storage: SettingsStorage,
): ChooserSettingsStore {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot;

  const publish = (
    settings: Readonly<ChooserSettings>,
    persistence: SettingsPersistence,
  ) => {
    if (
      settingsEqual(snapshot.settings, settings) &&
      snapshot.persistence === persistence
    ) {
      return snapshot;
    }

    snapshot = Object.freeze({
      settings: freezeSettings(settings),
      persistence,
    });
    listeners.forEach((listener) => listener());
    return snapshot;
  };

  const persist = (settings: Readonly<ChooserSettings>) => {
    try {
      storage.setItem(
        CHOOSER_SETTINGS_STORAGE_KEY,
        serializeSettings(settings),
      );
      return publish(settings, "saved");
    } catch {
      return publish(settings, "not-saved");
    }
  };

  return {
    getSnapshot() {
      return snapshot;
    },

    load() {
      let storedValue: string | null;
      try {
        storedValue = storage.getItem(CHOOSER_SETTINGS_STORAGE_KEY);
      } catch {
        return publish(DEFAULT_CHOOSER_SETTINGS, "not-saved");
      }

      const settings = readStoredSettings(storedValue);
      const canonicalValue = serializeSettings(settings);
      if (storedValue === canonicalValue) {
        return publish(settings, "saved");
      }
      return persist(settings);
    },

    reset() {
      if (
        settingsEqual(snapshot.settings, DEFAULT_CHOOSER_SETTINGS) &&
        snapshot.persistence === "saved"
      ) {
        return snapshot;
      }
      return persist(DEFAULT_CHOOSER_SETTINGS);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    update(patch) {
      const settings = normalizeVersionOne({
        ...snapshot.settings,
        ...patch,
        version: 1,
      });
      if (
        settingsEqual(snapshot.settings, settings) &&
        snapshot.persistence === "saved"
      ) {
        return snapshot;
      }
      return persist(settings);
    },
  };
}

function readStoredSettings(storedValue: string | null) {
  if (storedValue === null) {
    return DEFAULT_CHOOSER_SETTINGS;
  }

  try {
    const record: unknown = JSON.parse(storedValue);
    if (!isRecord(record) || record.version !== 1) {
      return DEFAULT_CHOOSER_SETTINGS;
    }
    return normalizeVersionOne(record);
  } catch {
    return DEFAULT_CHOOSER_SETTINGS;
  }
}

function normalizeVersionOne(
  record: Record<string, unknown>,
): Readonly<ChooserSettings> {
  const selectionMode = readMode(record.selectionMode);

  return freezeSettings({
    selectionMode,
    selectionCount: readSelectionCount(record.selectionCount, selectionMode),
    soundEnabled: readBoolean(
      record.soundEnabled,
      DEFAULT_CHOOSER_SETTINGS.soundEnabled,
    ),
    vibrationEnabled: readBoolean(
      record.vibrationEnabled,
      DEFAULT_CHOOSER_SETTINGS.vibrationEnabled,
    ),
    topPaddingPx: readSteppedNumber(
      record.topPaddingPx,
      CHOOSER_SETTINGS_CONSTRAINTS.topPaddingPx,
      DEFAULT_CHOOSER_SETTINGS.topPaddingPx,
    ),
    circleSizePercent: readSteppedNumber(
      record.circleSizePercent,
      CHOOSER_SETTINGS_CONSTRAINTS.circleSizePercent,
      DEFAULT_CHOOSER_SETTINGS.circleSizePercent,
    ),
    singleDelayMs: readSteppedNumber(
      record.singleDelayMs,
      CHOOSER_SETTINGS_CONSTRAINTS.selectionDelayMs,
      DEFAULT_CHOOSER_SETTINGS.singleDelayMs,
    ),
    groupDelayMs: readSteppedNumber(
      record.groupDelayMs,
      CHOOSER_SETTINGS_CONSTRAINTS.selectionDelayMs,
      DEFAULT_CHOOSER_SETTINGS.groupDelayMs,
    ),
    orderDelayMs: readSteppedNumber(
      record.orderDelayMs,
      CHOOSER_SETTINGS_CONSTRAINTS.selectionDelayMs,
      DEFAULT_CHOOSER_SETTINGS.orderDelayMs,
    ),
    singleLifetimeMs: readSteppedNumber(
      record.singleLifetimeMs,
      CHOOSER_SETTINGS_CONSTRAINTS.circleLifetimeMs,
      DEFAULT_CHOOSER_SETTINGS.singleLifetimeMs,
    ),
    groupLifetimeMs: readSteppedNumber(
      record.groupLifetimeMs,
      CHOOSER_SETTINGS_CONSTRAINTS.circleLifetimeMs,
      DEFAULT_CHOOSER_SETTINGS.groupLifetimeMs,
    ),
    orderLifetimeMs: readSteppedNumber(
      record.orderLifetimeMs,
      CHOOSER_SETTINGS_CONSTRAINTS.circleLifetimeMs,
      DEFAULT_CHOOSER_SETTINGS.orderLifetimeMs,
    ),
  });
}

function readMode(value: unknown): SelectionMode {
  return value === "single" || value === "group" || value === "order"
    ? value
    : DEFAULT_CHOOSER_SETTINGS.selectionMode;
}

function readSelectionCount(value: unknown, mode: SelectionMode) {
  if (mode === "order") {
    return 1;
  }

  const minimum = mode === "group" ? 2 : 1;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 5
    ? value
    : minimum;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readSteppedNumber(
  value: unknown,
  constraint: { minimum: number; maximum: number; step: number },
  fallback: number,
) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= constraint.minimum &&
    value <= constraint.maximum &&
    (value - constraint.minimum) % constraint.step === 0
    ? value
    : fallback;
}

function serializeSettings(settings: Readonly<ChooserSettings>) {
  return JSON.stringify({
    version: 1,
    selectionMode: settings.selectionMode,
    selectionCount: settings.selectionCount,
    soundEnabled: settings.soundEnabled,
    vibrationEnabled: settings.vibrationEnabled,
    topPaddingPx: settings.topPaddingPx,
    circleSizePercent: settings.circleSizePercent,
    singleDelayMs: settings.singleDelayMs,
    groupDelayMs: settings.groupDelayMs,
    orderDelayMs: settings.orderDelayMs,
    singleLifetimeMs: settings.singleLifetimeMs,
    groupLifetimeMs: settings.groupLifetimeMs,
    orderLifetimeMs: settings.orderLifetimeMs,
  });
}

function freezeSettings(
  settings: Readonly<ChooserSettings>,
): Readonly<ChooserSettings> {
  if (settingsEqual(settings, DEFAULT_CHOOSER_SETTINGS)) {
    return DEFAULT_CHOOSER_SETTINGS;
  }
  return Object.freeze({ ...settings });
}

function settingsEqual(
  left: Readonly<ChooserSettings>,
  right: Readonly<ChooserSettings>,
) {
  return (
    left.selectionMode === right.selectionMode &&
    left.selectionCount === right.selectionCount &&
    left.soundEnabled === right.soundEnabled &&
    left.vibrationEnabled === right.vibrationEnabled &&
    left.topPaddingPx === right.topPaddingPx &&
    left.circleSizePercent === right.circleSizePercent &&
    left.singleDelayMs === right.singleDelayMs &&
    left.groupDelayMs === right.groupDelayMs &&
    left.orderDelayMs === right.orderDelayMs &&
    left.singleLifetimeMs === right.singleLifetimeMs &&
    left.groupLifetimeMs === right.groupLifetimeMs &&
    left.orderLifetimeMs === right.orderLifetimeMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
