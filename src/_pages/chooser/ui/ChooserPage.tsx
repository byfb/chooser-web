// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  createChooserSession,
  type ChooserClock,
  type ChooserScheduler,
} from "../model/chooser-session";
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

export interface ChooserPageProps {
  settings: Readonly<ChooserSettings>;
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
  onOpenSettings,
  onUpdateSettings,
}: ChooserPageProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const pendingHoldRef = useRef<PendingHold | null>(null);
  const suppressNextClickRef = useRef(false);
  const keyboardMarkerIndexRef = useRef(0);
  const [session] = useState(() =>
    createChooserSession({
      clock: createBrowserClock(),
      effects: {
        playSound: () => undefined,
        vibrate: () => undefined,
      },
      random: { next: () => Math.random() },
      scheduler: createBrowserScheduler(),
      settings,
    }),
  );
  const snapshot = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getSnapshot(),
    () => session.getSnapshot(),
  );
  const controlsVisible = snapshot.controlsVisible;

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
      session.destroy();
    },
    [session],
  );

  useEffect(() => {
    if (!controlsVisible) {
      clearPendingHold();
    }
  }, [controlsVisible]);

  useEffect(() => {
    if (session.getSnapshot().phase === "idle") {
      session.send({ type: "settings-changed", settings });
    }
  }, [session, settings, snapshot.phase]);

  const canChangeSettings = () => session.getSnapshot().phase === "idle";

  const cycleMode = () => {
    if (!canChangeSettings()) {
      return;
    }

    const selectionMode = nextMode[snapshot.selectionMode];
    onUpdateSettings({
      selectionMode,
      selectionCount: initialCount[selectionMode],
    });
  };

  const cycleCount = () => {
    if (!canChangeSettings() || snapshot.selectionMode === "order") {
      return;
    }

    const minimum = snapshot.selectionMode === "group" ? 2 : 1;
    const selectionCount =
      snapshot.selectionCount >= 5 ? minimum : snapshot.selectionCount + 1;
    onUpdateSettings({ selectionCount });
  };

  const beginModeHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || !canChangeSettings()) {
      return;
    }

    clearPendingHold();
    suppressNextClickRef.current = false;
    capturePointer(event.currentTarget, event.pointerId);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      const pendingHold = pendingHoldRef.current;
      if (
        pendingHold?.pointerId !== pointerId ||
        session.getSnapshot().phase !== "idle"
      ) {
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

  const sendSurfacePointer = (
    event: ReactPointerEvent<HTMLElement>,
    type: "pointer-down" | "pointer-move" | "pointer-up",
  ) => {
    const pointerType = normalizePointerType(event.pointerType);
    if (pointerType === null) {
      return;
    }

    const position = normalizePosition(event);
    if (type === "pointer-down") {
      capturePointer(event.currentTarget, event.pointerId);
      session.send({
        type,
        button: event.button,
        isPrimary: event.isPrimary,
        pointerId: event.pointerId,
        pointerType,
        position,
      });
      return;
    }

    if (type === "pointer-move") {
      session.send({ type, pointerId: event.pointerId, position });
      return;
    }

    session.send({ type, pointerId: event.pointerId, position });
  };

  const sendKeyboardMarker = () => {
    const surface = surfaceRef.current;
    if (surface === null) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    const markerIndex = keyboardMarkerIndexRef.current++;
    const column = markerIndex % 3;
    const row = Math.floor(markerIndex / 3) % 3;
    const position = {
      x: rect.width * (0.25 + column * 0.25),
      y: rect.height * (0.25 + row * 0.25),
    };
    const pointerId = -1 - markerIndex;
    session.send({
      type: "pointer-down",
      button: 0,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
      position,
    });
    session.send({ type: "pointer-up", pointerId, position });
  };

  const handleSurfaceKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      sendKeyboardMarker();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      session.send({ type: "remove-latest-simulated" });
    }
  };

  const controlStyle = {
    "--chooser-top-padding": `${settings.topPaddingPx}px`,
  } as CSSProperties;

  return (
    <main
      ref={surfaceRef}
      aria-label="Chooser"
      className={`chooser-surface ${styles.surface}`}
      data-phase={snapshot.phase}
      data-route="chooser"
      data-route-focus
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={handleSurfaceKeyDown}
      onLostPointerCapture={(event) =>
        session.send({
          type: "lost-pointer-capture",
          pointerId: event.pointerId,
        })
      }
      onPointerCancel={(event) =>
        session.send({ type: "pointer-cancel", pointerId: event.pointerId })
      }
      onPointerDown={(event) => sendSurfacePointer(event, "pointer-down")}
      onPointerMove={(event) => sendSurfacePointer(event, "pointer-move")}
      onPointerUp={(event) => sendSurfacePointer(event, "pointer-up")}
      style={{
        backgroundColor: `rgb(${snapshot.background.r} ${snapshot.background.g} ${snapshot.background.b})`,
      }}
      tabIndex={0}
    >
      <div aria-hidden="true" className={styles.participantLayer}>
        {snapshot.participants.map((participant) => (
          <span
            className={styles.participant}
            data-participant-id={participant.id}
            data-state={participant.state}
            key={participant.id}
            style={participantStyle(participant, settings.circleSizePercent)}
          />
        ))}
      </div>

      <div
        aria-hidden={!controlsVisible}
        className={`${styles.controls} ${
          controlsVisible ? "" : styles.controlsHidden
        }`}
        style={controlStyle}
      >
        <button
          aria-label={`Selection mode: ${modeName[snapshot.selectionMode]}. Activate to change; hold for Settings.`}
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
              if (canChangeSettings()) {
                onOpenSettings();
              }
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
            src={modeIcon[snapshot.selectionMode]}
          />
        </button>

        {snapshot.selectionMode === "order" ? null : (
          <button
            aria-label={`Selection count: ${snapshot.selectionCount}. Activate to change.`}
            className={`${styles.control} ${styles.countControl}`}
            onClick={(event) => {
              event.stopPropagation();
              cycleCount();
            }}
            onPointerCancel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            tabIndex={controlsVisible ? 0 : -1}
            type="button"
          >
            {snapshot.selectionCount}
          </button>
        )}
      </div>

      <p aria-live="polite" className={styles.liveRegion}>
        {getChooserAnnouncement(
          snapshot.phase,
          snapshot.activeParticipantCount,
        )}
      </p>
    </main>
  );
}

type ChooserParticipant = ReturnType<
  typeof createChooserSession
>["getSnapshot"] extends () => infer Snapshot
  ? Snapshot extends { participants: readonly (infer Participant)[] }
    ? Participant
    : never
  : never;

function participantStyle(
  participant: ChooserParticipant,
  sizePercent: number,
): CSSProperties {
  return {
    "--participant-color": `rgb(${participant.color.r} ${participant.color.g} ${participant.color.b})`,
    "--participant-scale": Math.max(0.5, Math.min(1.5, sizePercent / 100)),
    left: `${participant.position.x}px`,
    top: `${participant.position.y}px`,
  } as CSSProperties;
}

function getChooserAnnouncement(phase: string, activeParticipantCount: number) {
  if (phase === "idle") {
    return `Ready. ${activeParticipantCount} participants.`;
  }
  if (phase === "collecting") {
    return `Collecting ${activeParticipantCount} participants.`;
  }
  return `Chooser ${phase}. ${activeParticipantCount} participants.`;
}

function normalizePointerType(pointerType: string) {
  if (pointerType === "touch" || pointerType === "pen") {
    return pointerType;
  }
  if (pointerType === "mouse" || pointerType === "trackpad") {
    return pointerType;
  }
  return null;
}

function normalizePosition(event: ReactPointerEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function capturePointer(element: HTMLElement, pointerId: number) {
  try {
    if (typeof element.setPointerCapture === "function") {
      element.setPointerCapture(pointerId);
    }
  } catch {
    // Pointer capture is best effort; the terminal event still reaches the model.
  }
}

function createBrowserClock(): ChooserClock {
  return { now: () => performance.now() };
}

function createBrowserScheduler(): ChooserScheduler {
  return {
    cancelAnimationFrame: (handle) => {
      window.cancelAnimationFrame(handle as number);
    },
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number);
    },
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  };
}
