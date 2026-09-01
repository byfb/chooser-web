// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

export type SelectionMode = "single" | "group" | "order";

export interface ChooserSettings {
  selectionMode: SelectionMode;
  selectionCount: number;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  topPaddingPx: number;
  circleSizePercent: number;
  singleDelayMs: number;
  groupDelayMs: number;
  orderDelayMs: number;
  singleLifetimeMs: number;
  groupLifetimeMs: number;
  orderLifetimeMs: number;
}
