// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ChooserSettings, SelectionMode } from "../model/chooser-settings";
import styles from "./ChooserPage.module.css";
import groupIcon from "./icons/group.svg";
import orderIcon from "./icons/order.svg";
import singleIcon from "./icons/single.svg";

const LONG_PRESS_DURATION_MS = 500;
const LONG_PRESS_MOVEMENT_TOLERANCE_PX = 10;

const nextMode: Record<SelectionMode, SelectionMode> = {
  single: "group",
  group: "order",
  order: "single",
};

const initialCount: Record<SelectionMode, number> = {
  single: 1,
  group: 2,
  order: 1,
};

const modeIcon: Record<SelectionMode, string> = {
  single: singleIcon.src,
  group: groupIcon.src,
  order: orderIcon.src,
};

const modeName: Record<SelectionMode, string> = {
  single: "Single",
  group: "Group",
  order: "Order",
};

interface ChooserPageProps {
  settings: Readonly<ChooserSettings>;
  controlsVisible?: boolean;
  onOpenSettings(): void;
  onUpdateSettings(patch: Partial<ChooserSettings>): void;
}

interface PendingHold {
  pointerId: number;
  startX: number;
  startY: number;
  timer: number;
}

export function ChooserPage({
  settings,
  controlsVisible = true,
  onOpenSettings,
  onUpdateSettings,
}: ChooserPageProps) {
  const pendingHoldRef = useRef<PendingHold | null>(null);
  const suppressNextClickRef = useRef(false);

  const clearPendingHold = () => {
    const pendingHold = pendingHoldRef.current;
    if (pendingHold !== null) {
      window.clearTimeout(pendingHold.timer);
      pendingHoldRef.current = null;
    }
  };

  useEffect(
    () => () => {
      const pendingHold = pendingHoldRef.current;
      if (pendingHold !== null) {
        window.clearTimeout(pendingHold.timer);
      }
    },
    [],
  );

  const cycleMode = () => {
    const selectionMode = nextMode[settings.selectionMode];
    onUpdateSettings({
      selectionMode,
      selectionCount: initialCount[selectionMode],
    });
  };

  const cycleCount = () => {
    const minimum = settings.selectionMode === "group" ? 2 : 1;
    const selectionCount =
      settings.selectionCount >= 5 ? minimum : settings.selectionCount + 1;
    onUpdateSettings({ selectionCount });
  };

  const beginModeHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }

    clearPendingHold();
    suppressNextClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      const pendingHold = pendingHoldRef.current;
      if (pendingHold?.pointerId !== pointerId) {
        return;
      }

      pendingHoldRef.current = null;
      suppressNextClickRef.current = true;
      onOpenSettings();
    }, LONG_PRESS_DURATION_MS);
    pendingHoldRef.current = { pointerId, startX, startY, timer };
  };

  const trackModeHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const pendingHold = pendingHoldRef.current;
    if (pendingHold?.pointerId !== event.pointerId) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - pendingHold.startX,
      event.clientY - pendingHold.startY,
    );
    if (distance > LONG_PRESS_MOVEMENT_TOLERANCE_PX) {
      suppressNextClickRef.current = true;
      clearPendingHold();
    }
  };

  const finishModeHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clearPendingHold();
  };

  const cancelModeHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (pendingHoldRef.current?.pointerId === event.pointerId) {
      suppressNextClickRef.current = true;
    }
    clearPendingHold();
  };

  const controlStyle = {
    "--chooser-top-padding": `${settings.topPaddingPx}px`,
  } as CSSProperties;

  return (
    <main
      aria-label="Chooser"
      className={`chooser-surface ${styles.surface}`}
      data-route="chooser"
      data-route-focus
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      tabIndex={0}
    >
      <div
        aria-hidden={!controlsVisible}
        className={`${styles.controls} ${
          controlsVisible ? "" : styles.controlsHidden
        }`}
        style={controlStyle}
      >
        <button
          aria-label={`Selection mode: ${modeName[settings.selectionMode]}. Activate to change; hold for Settings.`}
          className={`${styles.control} ${styles.modeControl}`}
          onClick={(event) => {
            event.stopPropagation();
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false;
              return;
            }
            cycleMode();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              onOpenSettings();
            }
          }}
          onLostPointerCapture={cancelModeHold}
          onPointerCancel={cancelModeHold}
          onPointerDown={beginModeHold}
          onPointerMove={trackModeHold}
          onPointerUp={finishModeHold}
          tabIndex={controlsVisible ? 0 : -1}
          type="button"
        >
          <img
            alt=""
            aria-hidden="true"
            className={styles.modeIcon}
            draggable={false}
            src={modeIcon[settings.selectionMode]}
          />
        </button>

        {settings.selectionMode === "order" ? null : (
          <button
            aria-label={`Selection count: ${settings.selectionCount}. Activate to change.`}
            className={`${styles.control} ${styles.countControl}`}
            onClick={(event) => {
              event.stopPropagation();
              cycleCount();
            }}
            tabIndex={controlsVisible ? 0 : -1}
            type="button"
          >
            {settings.selectionCount}
          </button>
        )}
      </div>
    </main>
  );
}
