// SPDX-FileCopyrightText: 2026 byfb
// SPDX-FileCopyrightText: 2025 UrAvgCode
// SPDX-FileContributor: Patch4Code
// SPDX-License-Identifier: GPL-3.0-or-later

interface SettingsPageProps {
  onBack(): void;
  onOpenLegal(): void;
}

export function SettingsPage({ onBack, onOpenLegal }: SettingsPageProps) {
  return (
    <main
      aria-labelledby="settings-title"
      className="settings-route"
      data-route="settings"
      data-route-focus
      tabIndex={-1}
    >
      <header className="settings-app-bar">
        <button
          aria-label="Back to Chooser"
          className="route-back-button"
          onClick={onBack}
          type="button"
        >
          <span aria-hidden="true">←</span>
        </button>
        <h1 id="settings-title">Settings</h1>
      </header>
      <div className="settings-route-content">
        <button
          className="settings-route-row"
          onClick={onOpenLegal}
          type="button"
        >
          <span>Legal</span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </main>
  );
}
