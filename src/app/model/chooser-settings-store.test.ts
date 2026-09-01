// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  CHOOSER_SETTINGS_STORAGE_KEY,
  DEFAULT_CHOOSER_SETTINGS,
  createChooserSettingsStore,
  type ChooserSettings,
  type SettingsStorage,
} from "./chooser-settings-store";

describe("Chooser settings store", () => {
  it("writes a versioned default record when storage is empty", () => {
    const storage = createStorage();
    const store = createChooserSettingsStore(storage.port);

    const snapshot = store.load();

    expect(snapshot).toEqual({
      settings: DEFAULT_CHOOSER_SETTINGS,
      persistence: "saved",
    });
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.value ?? "")).toEqual({
      version: 1,
      ...DEFAULT_CHOOSER_SETTINGS,
    });
  });

  it("keeps canonical records and saved no-op updates stable", () => {
    const storage = createStorage(
      JSON.stringify({ version: 1, ...DEFAULT_CHOOSER_SETTINGS }),
    );
    const store = createChooserSettingsStore(storage.port);
    const loaded = store.load();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.update({})).toBe(loaded);
    expect(storage.writes).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes valid version-one fields independently and rewrites the record", () => {
    const storage = createStorage(
      JSON.stringify({
        version: 1,
        selectionMode: "group",
        selectionCount: 1,
        soundEnabled: false,
        vibrationEnabled: "false",
        topPaddingPx: 15,
        circleSizePercent: 155,
        singleDelayMs: 2500,
        groupDelayMs: 2600,
        orderDelayMs: 0,
        singleLifetimeMs: 500,
        groupLifetimeMs: -500,
        orderLifetimeMs: 2500,
        ignored: true,
      }),
    );
    const store = createChooserSettingsStore(storage.port);

    expect(store.load().settings).toEqual({
      selectionMode: "group",
      selectionCount: 2,
      soundEnabled: false,
      vibrationEnabled: true,
      topPaddingPx: 15,
      circleSizePercent: 100,
      singleDelayMs: 2500,
      groupDelayMs: 3000,
      orderDelayMs: 0,
      singleLifetimeMs: 500,
      groupLifetimeMs: 1000,
      orderLifetimeMs: 2500,
    });
    expect(storage.writes).toBe(1);
  });

  it("falls back only invalid fields in a supported record", () => {
    const storage = createStorage(
      JSON.stringify({
        version: 1,
        selectionMode: "mystery",
        selectionCount: 5,
      }),
    );
    const store = createChooserSettingsStore(storage.port);

    expect(store.load().settings).toEqual({
      ...DEFAULT_CHOOSER_SETTINGS,
      selectionCount: 5,
    });
    expect(storage.writes).toBe(1);
  });

  it.each(["{", JSON.stringify({ version: 2, soundEnabled: false })])(
    "falls back to all defaults for malformed or unsupported data",
    (storedValue) => {
      const storage = createStorage(storedValue);
      const store = createChooserSettingsStore(storage.port);

      expect(store.load()).toEqual({
        settings: DEFAULT_CHOOSER_SETTINGS,
        persistence: "saved",
      });
      expect(storage.writes).toBe(1);
    },
  );

  it("continues in memory and reports Not saved when storage cannot be read", () => {
    const storage = createStorage();
    storage.failReads = true;
    const store = createChooserSettingsStore(storage.port);

    expect(store.load()).toEqual({
      settings: DEFAULT_CHOOSER_SETTINGS,
      persistence: "not-saved",
    });
    expect(storage.writes).toBe(0);
  });

  it("publishes updates, survives write failures, and recovers on a later update", () => {
    const storage = createStorage();
    const store = createChooserSettingsStore(storage.port);
    store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    storage.failWrites = true;

    expect(store.update({ soundEnabled: false })).toEqual({
      settings: { ...DEFAULT_CHOOSER_SETTINGS, soundEnabled: false },
      persistence: "not-saved",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    storage.failWrites = false;
    expect(store.update({ vibrationEnabled: false })).toEqual({
      settings: {
        ...DEFAULT_CHOOSER_SETTINGS,
        soundEnabled: false,
        vibrationEnabled: false,
      },
      persistence: "saved",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("resets once and remains idempotent when already at saved defaults", () => {
    const storage = createStorage();
    const store = createChooserSettingsStore(storage.port);
    store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ circleSizePercent: 150 });

    expect(store.reset()).toEqual({
      settings: DEFAULT_CHOOSER_SETTINGS,
      persistence: "saved",
    });
    expect(store.reset()).toBe(store.getSnapshot());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(storage.writes).toBe(3);
  });

  it("stops notifying an unsubscribed listener", () => {
    const storage = createStorage();
    const store = createChooserSettingsStore(storage.port);
    store.load();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.update({ topPaddingPx: 10 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes arbitrary stored JSON without breaking public invariants", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const storage = createStorage(JSON.stringify(value));
        const store = createChooserSettingsStore(storage.port);

        const { settings } = store.load();
        expect(["single", "group", "order"]).toContain(settings.selectionMode);
        expect(settings.topPaddingPx).toBeGreaterThanOrEqual(0);
        expect(settings.topPaddingPx).toBeLessThanOrEqual(50);
        expect(settings.topPaddingPx % 5).toBe(0);
        expect(settings.circleSizePercent).toBeGreaterThanOrEqual(50);
        expect(settings.circleSizePercent).toBeLessThanOrEqual(150);
        expect(settings.circleSizePercent % 10).toBe(0);
        expect(settings.singleDelayMs % 500).toBe(0);
        expect(settings.groupDelayMs % 500).toBe(0);
        expect(settings.orderDelayMs % 500).toBe(0);
        expect(settings.singleLifetimeMs % 500).toBe(0);
        expect(settings.groupLifetimeMs % 500).toBe(0);
        expect(settings.orderLifetimeMs % 500).toBe(0);
      }),
    );
  });

  it("round-trips every valid settings record", () => {
    fc.assert(
      fc.property(validSettingsArbitrary, (settings) => {
        const storage = createStorage();
        const firstStore = createChooserSettingsStore(storage.port);
        firstStore.load();
        firstStore.update(settings);

        const restoredStore = createChooserSettingsStore(storage.port);
        expect(restoredStore.load().settings).toEqual(settings);
      }),
    );
  });
});

const commonSettingsModel = {
  soundEnabled: fc.boolean(),
  vibrationEnabled: fc.boolean(),
  topPaddingPx: fc.integer({ min: 0, max: 10 }).map((value) => value * 5),
  circleSizePercent: fc.integer({ min: 5, max: 15 }).map((value) => value * 10),
  singleDelayMs: steppedMilliseconds(0, 5000),
  groupDelayMs: steppedMilliseconds(0, 5000),
  orderDelayMs: steppedMilliseconds(0, 5000),
  singleLifetimeMs: steppedMilliseconds(0, 3000),
  groupLifetimeMs: steppedMilliseconds(0, 3000),
  orderLifetimeMs: steppedMilliseconds(0, 3000),
};

const validSettingsArbitrary: fc.Arbitrary<ChooserSettings> = fc.oneof(
  fc.record({
    selectionMode: fc.constant("single" as const),
    selectionCount: fc.integer({ min: 1, max: 5 }),
    ...commonSettingsModel,
  }),
  fc.record({
    selectionMode: fc.constant("group" as const),
    selectionCount: fc.integer({ min: 2, max: 5 }),
    ...commonSettingsModel,
  }),
  fc.record({
    selectionMode: fc.constant("order" as const),
    selectionCount: fc.constant(1),
    ...commonSettingsModel,
  }),
);

function steppedMilliseconds(minimum: number, maximum: number) {
  return fc
    .integer({ min: minimum / 500, max: maximum / 500 })
    .map((value) => value * 500);
}

function createStorage(initialValue: string | null = null) {
  let value = initialValue;
  let writes = 0;
  let failReads = false;
  let failWrites = false;

  const port: SettingsStorage = {
    getItem(key) {
      if (key !== CHOOSER_SETTINGS_STORAGE_KEY) {
        throw new Error(`Unexpected storage key: ${key}`);
      }
      if (failReads) {
        throw new Error("Storage read failed");
      }
      return value;
    },
    setItem(key, nextValue) {
      if (key !== CHOOSER_SETTINGS_STORAGE_KEY) {
        throw new Error(`Unexpected storage key: ${key}`);
      }
      if (failWrites) {
        throw new Error("Storage write failed");
      }
      value = nextValue;
      writes += 1;
    },
  };

  return {
    port,
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
    get failReads() {
      return failReads;
    },
    set failReads(nextValue: boolean) {
      failReads = nextValue;
    },
    get failWrites() {
      return failWrites;
    },
    set failWrites(nextValue: boolean) {
      failWrites = nextValue;
    },
  };
}
