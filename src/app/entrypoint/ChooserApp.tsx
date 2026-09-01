// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, useSyncExternalStore } from "react";

import { ChooserPage } from "@/_pages/chooser";
import { LegalPage, SettingsPage } from "@/_pages/settings";
import { APP_ROUTES } from "@/shared/config";

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

export function ChooserApp({ initialPathname }: ChooserAppProps) {
  const initialRoute = resolveRoute(initialPathname);
  const [router] = useState<ChooserRouter | null>(() =>
    typeof window === "undefined"
      ? null
      : createChooserRouter(createWindowPort()),
  );
  const route = useSyncExternalStore(
    router?.subscribe ?? emptySubscribe,
    router?.getSnapshot ?? (() => initialRoute),
    () => initialRoute,
  );

  useEffect(() => router?.start(), [router]);

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
        onBack={() => router?.back()}
        onOpenLegal={() => router?.navigate(APP_ROUTES.legal)}
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
