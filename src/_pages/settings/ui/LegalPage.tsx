// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

interface LegalPageProps {
  onBack(): void;
}

export function LegalPage({ onBack }: LegalPageProps) {
  return (
    <main
      aria-labelledby="legal-title"
      className="settings-route"
      data-route="legal"
      data-route-focus
      tabIndex={-1}
    >
      <header className="settings-app-bar">
        <button
          aria-label="Back to Settings"
          className="route-back-button"
          onClick={onBack}
          type="button"
        >
          <span aria-hidden="true">←</span>
        </button>
        <h1 id="legal-title">Legal</h1>
      </header>
      <div className="settings-route-content" />
    </main>
  );
}
