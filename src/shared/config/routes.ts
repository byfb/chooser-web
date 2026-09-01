// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

export const APP_ROUTES = {
  chooser: "/",
  settings: "/settings",
  legal: "/settings/legal",
} as const;

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];
