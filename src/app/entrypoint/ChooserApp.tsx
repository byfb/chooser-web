// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, useSyncExternalStore } from "react";

import { ChooserPage } from "@/_pages/chooser";
import {
  createSettingsCapabilityModel,
  LegalPage,
  SettingsPage,
  type SettingsCapabilityBrowser,
  type SettingsCapabilityModel,
  type SettingsCapabilitySnapshot,
} from "@/_pages/settings";
import { APP_NAME, APP_ROUTES } from "@/shared/config";

import {
  createChooserSettingsStore,
  DEFAULT_CHOOSER_SETTINGS,
  type ChooserSettingsSnapshot,
  type ChooserSettingsStore,
  type SettingsStorage,
} from "../model";
import {
  createChooserRouter,
  resolveRoute,
  type ChooserBrowserPort,
  type ChooserRouter,
} from "../routing";

interface ChooserAppProps {
  initialPathname: string;
}

const emptySubscribe = () => () => undefined;
const serverSettingsSnapshot: ChooserSettingsSnapshot = Object.freeze({
  settings: DEFAULT_CHOOSER_SETTINGS,
  persistence: "saved",
});
const serverCapabilitySnapshot: SettingsCapabilitySnapshot = Object.freeze({
  fullscreen: Object.freeze({
    supported: false,
    active: false,
    disabled: true,
    status: "Unavailable",
    displayMode: "browser",
  }),
  vibration: Object.freeze({
    supported: false,
    disabled: true,
    status: "Unavailable",
  }),
});

export function ChooserApp({ initialPathname }: ChooserAppProps) {
  const initialRoute = resolveRoute(initialPathname);
  const [router] = useState<ChooserRouter | null>(() =>
    typeof window === "undefined"
      ? null
      : createChooserRouter(createWindowPort()),
  );
  const [settingsStore] = useState<ChooserSettingsStore | null>(() =>
    typeof window === "undefined"
      ? null
      : createChooserSettingsStore(createWindowSettingsStorage()),
  );
  const [capabilityModel] = useState<SettingsCapabilityModel | null>(() =>
    typeof window === "undefined"
      ? null
      : createSettingsCapabilityModel(createWindowCapabilityBrowser()),
  );
  const route = useSyncExternalStore(
    router?.subscribe ?? emptySubscribe,
    router?.getSnapshot ?? (() => initialRoute),
    () => initialRoute,
  );
  const settingsSnapshot = useSyncExternalStore(
    settingsStore?.subscribe ?? emptySubscribe,
    settingsStore?.getSnapshot ?? (() => serverSettingsSnapshot),
    () => serverSettingsSnapshot,
  );
  const capabilitySnapshot = useSyncExternalStore(
    capabilityModel?.subscribe ?? emptySubscribe,
    capabilityModel?.getSnapshot ?? (() => serverCapabilitySnapshot),
    () => serverCapabilitySnapshot,
  );

  useEffect(() => router?.start(), [router]);
  useEffect(() => capabilityModel?.start(), [capabilityModel]);
  useEffect(() => {
    settingsStore?.load();
  }, [settingsStore]);

  useEffect(() => {
    document.title =
      route === APP_ROUTES.settings
        ? `Settings — ${APP_NAME}`
        : route === APP_ROUTES.legal
          ? `Legal — ${APP_NAME}`
          : APP_NAME;
  }, [route]);

  useEffect(() => {
    if (!router || route === APP_ROUTES.chooser) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        router.back();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route, router]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-route-focus]")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route]);

  if (route === APP_ROUTES.settings) {
    return (
      <SettingsPage
        fullscreen={capabilitySnapshot.fullscreen}
        onBack={() => router?.back()}
        onOpenLegal={() => router?.navigate(APP_ROUTES.legal)}
        onReset={() => settingsStore?.reset()}
        onToggleFullscreen={() => {
          void capabilityModel?.toggleFullscreen();
        }}
        onUpdate={(patch) => settingsStore?.update(patch)}
        persistence={settingsSnapshot.persistence}
        settings={settingsSnapshot.settings}
        vibrationSupported={capabilitySnapshot.vibration.supported}
      />
    );
  }

  if (route === APP_ROUTES.legal) {
    return <LegalPage onBack={() => router?.back()} />;
  }

  return <ChooserPage />;
}

function createWindowPort(): ChooserBrowserPort {
  return {
    location: window.location,
    history: window.history,
    addEventListener: (_type, listener) =>
      window.addEventListener("popstate", listener),
    removeEventListener: (_type, listener) =>
      window.removeEventListener("popstate", listener),
  };
}

function createWindowSettingsStorage(): SettingsStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

function createWindowCapabilityBrowser(): SettingsCapabilityBrowser {
  return {
    document,
    navigator,
    matchMedia: (query) => window.matchMedia(query),
  };
}
