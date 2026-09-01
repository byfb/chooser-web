// SPDX-FileCopyrightText: 2026 byfb
// SPDX-FileCopyrightText: 2025 UrAvgCode
// SPDX-FileContributor: Patch4Code
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef } from "react";

import styles from "./SettingsPage.module.css";

interface SettingsValues {
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

export interface FullscreenControlState {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly status: "App mode" | "Unavailable" | null;
}

interface SettingsPageProps {
  fullscreen: FullscreenControlState;
  persistence: "saved" | "not-saved";
  settings: Readonly<SettingsValues>;
  vibrationSupported: boolean;
  onBack(): void;
  onOpenLegal(): void;
  onReset(): void;
  onToggleFullscreen(): void;
  onUpdate(patch: Partial<SettingsValues>): void;
}

export function SettingsPage({
  fullscreen,
  persistence,
  settings,
  vibrationSupported,
  onBack,
  onOpenLegal,
  onReset,
  onToggleFullscreen,
  onUpdate,
}: SettingsPageProps) {
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const resetDialogRef = useRef<HTMLDialogElement>(null);

  const openResetDialog = () => resetDialogRef.current?.showModal();
  const closeResetDialog = () => resetDialogRef.current?.close();
  const confirmReset = () => {
    onReset();
    closeResetDialog();
  };

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

      <div className={`settings-route-content ${styles.content}`}>
        {persistence === "not-saved" ? (
          <p className={styles.persistenceStatus} role="status">
            Not saved
          </p>
        ) : null}

        <SettingsSection id="feedback-section" title="Feedback">
          <SwitchRow
            checked={settings.soundEnabled}
            label="Sound"
            onChange={(soundEnabled) => onUpdate({ soundEnabled })}
          />
          <SwitchRow
            checked={settings.vibrationEnabled}
            disabled={!vibrationSupported}
            label="Vibration"
            onChange={(vibrationEnabled) => onUpdate({ vibrationEnabled })}
            status={!vibrationSupported ? "Unavailable" : null}
          />
        </SettingsSection>

        <SettingsSection id="display-section" title="Display">
          <SwitchRow
            checked={fullscreen.active}
            disabled={fullscreen.disabled}
            label="Fullscreen"
            onChange={onToggleFullscreen}
            status={fullscreen.status}
          />
          <RangeRow
            id="top-padding"
            label="Top padding"
            maximum={50}
            minimum={0}
            onChange={(topPaddingPx) => onUpdate({ topPaddingPx })}
            step={5}
            value={settings.topPaddingPx}
            valueLabel={`${settings.topPaddingPx} px`}
          />
          <RangeRow
            id="circle-size"
            label="Circle size"
            maximum={150}
            minimum={50}
            onChange={(circleSizePercent) => onUpdate({ circleSizePercent })}
            step={10}
            value={settings.circleSizePercent}
            valueLabel={`${settings.circleSizePercent}%`}
          />
        </SettingsSection>

        <SettingsSection id="selection-delays-section" title="Selection delays">
          <RangeRow
            id="single-delay"
            label="Single"
            maximum={5000}
            minimum={0}
            onChange={(singleDelayMs) => onUpdate({ singleDelayMs })}
            step={500}
            value={settings.singleDelayMs}
            valueLabel={formatSeconds(settings.singleDelayMs)}
          />
          <RangeRow
            id="group-delay"
            label="Group"
            maximum={5000}
            minimum={0}
            onChange={(groupDelayMs) => onUpdate({ groupDelayMs })}
            step={500}
            value={settings.groupDelayMs}
            valueLabel={formatSeconds(settings.groupDelayMs)}
          />
          <RangeRow
            id="order-delay"
            label="Order"
            maximum={5000}
            minimum={0}
            onChange={(orderDelayMs) => onUpdate({ orderDelayMs })}
            step={500}
            value={settings.orderDelayMs}
            valueLabel={formatSeconds(settings.orderDelayMs)}
          />
        </SettingsSection>

        <SettingsSection id="circle-lifetimes-section" title="Circle lifetimes">
          <RangeRow
            id="single-lifetime"
            label="Single"
            maximum={3000}
            minimum={0}
            onChange={(singleLifetimeMs) => onUpdate({ singleLifetimeMs })}
            step={500}
            value={settings.singleLifetimeMs}
            valueLabel={formatSeconds(settings.singleLifetimeMs)}
          />
          <RangeRow
            id="group-lifetime"
            label="Group"
            maximum={3000}
            minimum={0}
            onChange={(groupLifetimeMs) => onUpdate({ groupLifetimeMs })}
            step={500}
            value={settings.groupLifetimeMs}
            valueLabel={formatSeconds(settings.groupLifetimeMs)}
          />
          <RangeRow
            id="order-lifetime"
            label="Order"
            maximum={3000}
            minimum={0}
            onChange={(orderLifetimeMs) => onUpdate({ orderLifetimeMs })}
            step={500}
            value={settings.orderLifetimeMs}
            valueLabel={formatSeconds(settings.orderLifetimeMs)}
          />
        </SettingsSection>

        <button
          className={styles.resetButton}
          onClick={openResetDialog}
          ref={resetButtonRef}
          type="button"
        >
          Reset settings
        </button>

        <SettingsSection id="app-section" title="App">
          <div className={styles.readonlyRow}>
            <span>Offline</span>
            <span className={styles.statusValue}>Preparing</span>
          </div>
        </SettingsSection>

        <button
          className={styles.navigationRow}
          onClick={onOpenLegal}
          type="button"
        >
          <span>Legal</span>
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <dialog
        aria-describedby="reset-dialog-description"
        aria-labelledby="reset-dialog-title"
        className={styles.dialog}
        onCancel={(event) => {
          event.preventDefault();
          closeResetDialog();
        }}
        onClose={() => resetButtonRef.current?.focus()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeResetDialog();
          }
        }}
        ref={resetDialogRef}
      >
        <h2 id="reset-dialog-title">Reset settings</h2>
        <p id="reset-dialog-description">
          Reset all settings to their default values?
        </p>
        <div className={styles.dialogActions}>
          <button onClick={closeResetDialog} type="button">
            Cancel
          </button>
          <button
            className={styles.confirmResetButton}
            onClick={confirmReset}
            type="button"
          >
            Reset
          </button>
        </div>
      </dialog>
    </main>
  );
}

interface SettingsSectionProps {
  children: React.ReactNode;
  id: string;
  title: string;
}

function SettingsSection({ children, id, title }: SettingsSectionProps) {
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h2 id={id}>{title}</h2>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

interface SwitchRowProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  status?: "App mode" | "Unavailable" | null;
  onChange(checked: boolean): void;
}

function SwitchRow({
  checked,
  disabled = false,
  label,
  status = null,
  onChange,
}: SwitchRowProps) {
  const id = `setting-${label.toLowerCase().replaceAll(" ", "-")}`;
  const statusId = `${id}-status`;

  return (
    <label className={styles.switchRow} htmlFor={id}>
      <span>{label}</span>
      <span className={styles.switchValue}>
        {status ? (
          <span className={styles.statusValue} id={statusId}>
            {status}
          </span>
        ) : null}
        <input
          aria-describedby={status ? statusId : undefined}
          checked={checked}
          className={styles.switchInput}
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
      </span>
    </label>
  );
}

interface RangeRowProps {
  id: string;
  label: string;
  maximum: number;
  minimum: number;
  step: number;
  value: number;
  valueLabel: string;
  onChange(value: number): void;
}

function RangeRow({
  id,
  label,
  maximum,
  minimum,
  step,
  value,
  valueLabel,
  onChange,
}: RangeRowProps) {
  const inputId = `setting-${id}`;
  const outputId = `${inputId}-value`;

  return (
    <div className={styles.rangeRow}>
      <div className={styles.rangeHeading}>
        <label htmlFor={inputId}>{label}</label>
        <output htmlFor={inputId} id={outputId}>
          {valueLabel}
        </output>
      </div>
      <input
        aria-describedby={outputId}
        aria-valuetext={valueLabel}
        id={inputId}
        max={maximum}
        min={minimum}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        step={step}
        type="range"
        value={value}
      />
    </div>
  );
}

function formatSeconds(milliseconds: number) {
  return `${milliseconds / 1000} s`;
}
