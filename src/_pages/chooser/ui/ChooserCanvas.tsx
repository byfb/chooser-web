// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef } from "react";

import {
  chooserGroupColorAt,
  chooserOrderNumberAt,
  chooserParticipantRadius,
  chooserResetRadius,
  chooserSingleMaskRadius,
  configureChooserCanvasSurface,
  createChooserParticipantGeometry,
  farthestChooserCornerRadius,
  scaleChooserPosition,
  type ChooserCanvasViewport,
  type ChooserSurfaceSize,
} from "../model/chooser-rendering";
import type { ChooserSettings } from "../model/chooser-settings";
import type {
  ChooserColor,
  ChooserParticipant,
  ChooserSnapshot,
} from "../model/chooser-session";

const TAU = Math.PI * 2;
const RADIUS_SPEED_PX_PER_MS = 0.6;
const MAX_FRAME_DELTA_MS = 64;

export interface ChooserCanvasProps {
  readonly className?: string | undefined;
  readonly settings: Readonly<ChooserSettings>;
  readonly snapshot: Readonly<ChooserSnapshot>;
}

interface ParticipantVisual {
  coreRadius: number;
  elapsedMs: number;
  groupElapsedMs: number;
  participant: Readonly<ChooserParticipant>;
  rankElapsedMs: number | null;
  readonly ringStartDegrees: number;
  readonly ringSweepStartDegrees: number;
  resetStartRadius: number | null;
}

interface CanvasRenderState {
  lastFrameAtMs: number | null;
  lastSnapshot: Readonly<ChooserSnapshot> | null;
  reducedMotion: boolean;
  resetElapsedMs: number;
  resultElapsedMs: number;
  sourceSize: ChooserSurfaceSize | null;
  readonly visuals: Map<string, ParticipantVisual>;
}

export function ChooserCanvas({
  className,
  settings,
  snapshot,
}: ChooserCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scheduleRef = useRef<() => void>(() => undefined);
  const settingsRef = useRef(settings);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    const canvasElement: HTMLCanvasElement = canvas;
    const drawingContext: CanvasRenderingContext2D = context;

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const state: CanvasRenderState = {
      lastFrameAtMs: null,
      lastSnapshot: null,
      reducedMotion: reducedMotionQuery.matches,
      resetElapsedMs: 0,
      resultElapsedMs: 0,
      sourceSize: null,
      visuals: new Map(),
    };
    let animationFrame: number | null = null;
    let dprQuery: MediaQueryList | null = null;
    let mounted = true;

    const schedule = () => {
      if (!mounted || document.hidden || animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(drawFrame);
    };

    const handleDprChange = () => {
      bindDprQuery();
      schedule();
    };

    const bindDprQuery = () => {
      if (dprQuery !== null) {
        removeMediaListener(dprQuery, handleDprChange);
      }
      dprQuery = window.matchMedia(
        `(resolution: ${normalizedDevicePixelRatio()}dppx)`,
      );
      addMediaListener(dprQuery, handleDprChange);
    };

    const handleReducedMotionChange = () => {
      state.reducedMotion = reducedMotionQuery.matches;
      state.lastFrameAtMs = null;
      schedule();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseAnimation();
        return;
      }
      state.lastFrameAtMs = null;
      schedule();
    };

    const pauseAnimation = () => {
      state.lastFrameAtMs = null;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };

    const handlePageHide = () => pauseAnimation();

    const handlePageShow = () => {
      state.lastFrameAtMs = null;
      schedule();
    };

    function drawFrame(frameAtMs: number) {
      animationFrame = null;
      if (!mounted || document.hidden) {
        state.lastFrameAtMs = null;
        return;
      }

      const rect = canvasElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        state.lastFrameAtMs = null;
        return;
      }

      const viewport = configureChooserCanvasSurface(
        canvasElement,
        drawingContext,
        {
          cssHeight: rect.height,
          cssWidth: rect.width,
          dpr: normalizedDevicePixelRatio(),
        },
      );
      const frameDeltaMs =
        state.lastFrameAtMs === null
          ? 0
          : Math.min(
              MAX_FRAME_DELTA_MS,
              Math.max(0, frameAtMs - state.lastFrameAtMs),
            );
      state.lastFrameAtMs = frameAtMs;

      const currentSnapshot = snapshotRef.current;
      const currentSettings = settingsRef.current;
      syncSnapshot(
        state,
        currentSnapshot,
        currentSettings,
        viewport,
        frameDeltaMs,
      );
      advanceMotion(state, currentSnapshot, currentSettings, frameDeltaMs);
      drawSnapshot(
        drawingContext,
        state,
        currentSnapshot,
        currentSettings,
        viewport,
      );

      if (!state.reducedMotion && state.visuals.size > 0) {
        schedule();
      }
    }

    scheduleRef.current = schedule;
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => schedule())
        : null;
    resizeObserver?.observe(canvasElement);
    addMediaListener(reducedMotionQuery, handleReducedMotionChange);
    bindDprQuery();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      mounted = false;
      scheduleRef.current = () => undefined;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      removeMediaListener(reducedMotionQuery, handleReducedMotionChange);
      if (dprQuery !== null) {
        removeMediaListener(dprQuery, handleDprChange);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  useLayoutEffect(() => {
    settingsRef.current = settings;
    snapshotRef.current = snapshot;
    scheduleRef.current();
  }, [settings, snapshot]);

  return <canvas aria-hidden="true" className={className} ref={canvasRef} />;
}

function syncSnapshot(
  state: CanvasRenderState,
  snapshot: Readonly<ChooserSnapshot>,
  settings: Readonly<ChooserSettings>,
  viewport: Readonly<ChooserCanvasViewport>,
  frameDeltaMs: number,
) {
  if (state.lastSnapshot === snapshot) {
    return;
  }

  const previousSnapshot = state.lastSnapshot;
  const nominalRadius = chooserParticipantRadius(settings.circleSizePercent);
  const currentIds = new Set(snapshot.participants.map(({ id }) => id));
  for (const id of state.visuals.keys()) {
    if (!currentIds.has(id)) {
      state.visuals.delete(id);
    }
  }

  if (
    snapshot.participants.length > 0 &&
    state.sourceSize === null &&
    viewport.cssWidth > 0 &&
    viewport.cssHeight > 0
  ) {
    state.sourceSize = Object.freeze({
      height: viewport.cssHeight,
      width: viewport.cssWidth,
    });
  }

  snapshot.participants.forEach((participant) => {
    const visual = state.visuals.get(participant.id);
    if (visual === undefined) {
      const ranked = participant.rank !== undefined;
      state.visuals.set(participant.id, {
        coreRadius: state.reducedMotion
          ? nominalRadius
          : ranked
            ? nominalRadius * 1.2
            : 0,
        elapsedMs: 0,
        groupElapsedMs: participant.state === "grouped" ? -frameDeltaMs : 0,
        participant,
        rankElapsedMs: ranked ? -frameDeltaMs : null,
        ...stableRingPhases(participant.id),
        resetStartRadius: null,
      });
      return;
    }

    const becameGrouped =
      participant.state === "grouped" && visual.participant.state !== "grouped";
    const receivedRank =
      participant.rank !== undefined &&
      participant.rank !== visual.participant.rank;
    visual.participant = participant;
    if (becameGrouped) {
      visual.groupElapsedMs = -frameDeltaMs;
    }
    if (receivedRank) {
      visual.rankElapsedMs = -frameDeltaMs;
      visual.coreRadius = state.reducedMotion
        ? nominalRadius
        : Math.max(visual.coreRadius, nominalRadius * 1.2);
    }
  });

  if (
    snapshot.phase === "result" &&
    snapshot.result?.kind === "single" &&
    (previousSnapshot?.phase !== "result" ||
      previousSnapshot.result?.kind !== "single")
  ) {
    state.resultElapsedMs = -frameDeltaMs;
  }

  if (
    snapshot.phase === "resetting" &&
    previousSnapshot?.phase !== "resetting"
  ) {
    state.resetElapsedMs = -frameDeltaMs;
    state.visuals.forEach((visual) => {
      visual.resetStartRadius = state.reducedMotion
        ? nominalRadius
        : visual.coreRadius;
    });
  }

  if (snapshot.phase === "idle" && snapshot.participants.length === 0) {
    state.visuals.clear();
    state.sourceSize = null;
    state.resetElapsedMs = 0;
    state.resultElapsedMs = 0;
  }

  state.lastSnapshot = snapshot;
}

function advanceMotion(
  state: CanvasRenderState,
  snapshot: Readonly<ChooserSnapshot>,
  settings: Readonly<ChooserSettings>,
  deltaMs: number,
) {
  if (snapshot.phase === "result" && snapshot.result?.kind === "single") {
    state.resultElapsedMs += deltaMs;
  }
  if (snapshot.phase === "resetting") {
    state.resetElapsedMs += deltaMs;
  }

  const nominalRadius = chooserParticipantRadius(settings.circleSizePercent);
  const lifetimeMs = chooserLifetime(settings, snapshot.selectionMode);
  state.visuals.forEach((visual) => {
    visual.elapsedMs += deltaMs;
    if (visual.participant.state === "grouped") {
      visual.groupElapsedMs += deltaMs;
    }
    if (visual.rankElapsedMs !== null) {
      visual.rankElapsedMs += deltaMs;
    }

    if (snapshot.phase === "resetting") {
      visual.coreRadius = chooserResetRadius({
        elapsedMs: state.resetElapsedMs,
        lifetimeMs,
        reducedMotion: state.reducedMotion,
        startRadius: visual.resetStartRadius ?? visual.coreRadius,
      });
      return;
    }

    if (visual.participant.state === "retiring") {
      visual.coreRadius = state.reducedMotion
        ? 0
        : Math.max(0, visual.coreRadius - deltaMs * RADIUS_SPEED_PX_PER_MS);
      return;
    }

    visual.coreRadius = state.reducedMotion
      ? nominalRadius
      : moveTowards(
          visual.coreRadius,
          nominalRadius,
          deltaMs * RADIUS_SPEED_PX_PER_MS,
        );
  });
}

function drawSnapshot(
  context: CanvasRenderingContext2D,
  state: CanvasRenderState,
  snapshot: Readonly<ChooserSnapshot>,
  settings: Readonly<ChooserSettings>,
  viewport: Readonly<ChooserCanvasViewport>,
) {
  context.clearRect(0, 0, viewport.cssWidth, viewport.cssHeight);
  context.fillStyle = rgb(snapshot.background);
  context.fillRect(0, 0, viewport.cssWidth, viewport.cssHeight);
  const surface = Object.freeze({
    height: viewport.cssHeight,
    width: viewport.cssWidth,
  });

  if (
    !state.reducedMotion &&
    snapshot.phase === "result" &&
    snapshot.result?.kind === "single"
  ) {
    drawSingleMasks(context, state, snapshot, settings, surface);
  }

  snapshot.participants.forEach((participant) => {
    const visual = state.visuals.get(participant.id);
    if (visual === undefined) {
      return;
    }
    const position = renderedPosition(
      participant.position,
      state.sourceSize,
      surface,
    );
    const color = participantColor(visual, snapshot, state.reducedMotion);
    const geometry = createChooserParticipantGeometry({
      circleSizePercent: settings.circleSizePercent,
      coreRadius: visual.coreRadius,
      elapsedMs: visual.elapsedMs,
      reducedMotion: state.reducedMotion,
    });
    if (geometry.outerRadius <= 0) {
      return;
    }

    drawParticipant(
      context,
      position,
      color,
      geometry,
      visual,
      state.reducedMotion,
    );
    if (participant.rank !== undefined) {
      drawOrderLabel(
        context,
        position,
        color,
        geometry.outerRadius,
        participant.rank,
      );
    }
  });

  if (
    !state.reducedMotion &&
    snapshot.phase !== "resetting" &&
    snapshot.result?.kind === "order"
  ) {
    drawOrderNumbers(context, state, snapshot, settings, surface);
  }
}

function drawSingleMasks(
  context: CanvasRenderingContext2D,
  state: CanvasRenderState,
  snapshot: Readonly<ChooserSnapshot>,
  settings: Readonly<ChooserSettings>,
  surface: Readonly<ChooserSurfaceSize>,
) {
  if (snapshot.result?.kind !== "single") {
    return;
  }
  context.fillStyle = "#000";
  snapshot.result.selectedParticipantIds.forEach((participantId) => {
    const visual = state.visuals.get(participantId);
    if (visual === undefined) {
      return;
    }
    const position = renderedPosition(
      visual.participant.position,
      state.sourceSize,
      surface,
    );
    const initialRadius = farthestChooserCornerRadius(position, surface);
    const radius = chooserSingleMaskRadius({
      circleSizePercent: settings.circleSizePercent,
      elapsedMs: state.resultElapsedMs,
      initialRadius,
    });
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, TAU);
    context.fill();
  });
}

function drawParticipant(
  context: CanvasRenderingContext2D,
  position: Readonly<{ x: number; y: number }>,
  color: Readonly<ChooserColor>,
  geometry: Readonly<{
    innerRadius: number;
    outerRadius: number;
    strokeWidth: number;
  }>,
  visual: ParticipantVisual,
  reducedMotion: boolean,
) {
  const colorValue = rgb(color);
  context.lineWidth = geometry.strokeWidth;
  context.fillStyle = colorValue;
  context.strokeStyle = colorValue;
  context.beginPath();
  context.arc(position.x, position.y, geometry.innerRadius, 0, TAU);
  context.fill();
  context.stroke();

  const startDegrees =
    visual.ringStartDegrees + (reducedMotion ? 0 : visual.elapsedMs * 0.3);
  const sweepDegrees = reducedMotion
    ? 240
    : Math.min(360, visual.ringSweepStartDegrees + visual.elapsedMs * 0.45);
  drawArc(
    context,
    position,
    geometry.outerRadius,
    startDegrees,
    sweepDegrees,
    colorValue,
  );
  const lightColor = "rgb(255 255 255 / 25.5%)";
  drawArc(
    context,
    position,
    geometry.innerRadius,
    startDegrees + 180,
    sweepDegrees / 2,
    lightColor,
  );
  drawArc(
    context,
    position,
    geometry.outerRadius,
    startDegrees,
    sweepDegrees / 2,
    lightColor,
  );
}

function drawArc(
  context: CanvasRenderingContext2D,
  position: Readonly<{ x: number; y: number }>,
  radius: number,
  startDegrees: number,
  sweepDegrees: number,
  color: string,
) {
  const start = degreesToRadians(startDegrees);
  const end = start + degreesToRadians(sweepDegrees);
  context.strokeStyle = color;
  context.beginPath();
  context.arc(position.x, position.y, radius, start, end, sweepDegrees < 0);
  context.stroke();
}

function drawOrderLabel(
  context: CanvasRenderingContext2D,
  position: Readonly<{ x: number; y: number }>,
  color: Readonly<ChooserColor>,
  size: number,
  rank: number,
) {
  const label = String(rank);
  const shadowOffset = size * 0.04;
  context.font = `700 ${size}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgb(0 0 0 / 32%)";
  context.fillText(label, position.x + shadowOffset, position.y + shadowOffset);
  context.fillStyle = rgb(mixColor(color, { r: 255, g: 255, b: 255 }, 0.72));
  context.fillText(label, position.x, position.y);
}

function drawOrderNumbers(
  context: CanvasRenderingContext2D,
  state: CanvasRenderState,
  snapshot: Readonly<ChooserSnapshot>,
  settings: Readonly<ChooserSettings>,
  surface: Readonly<ChooserSurfaceSize>,
) {
  const size = chooserParticipantRadius(settings.circleSizePercent);
  snapshot.participants.forEach((participant) => {
    if (participant.rank === undefined) {
      return;
    }
    const visual = state.visuals.get(participant.id);
    if (visual?.rankElapsedMs === null || visual === undefined) {
      return;
    }
    const position = renderedPosition(
      participant.position,
      state.sourceSize,
      surface,
    );
    const number = chooserOrderNumberAt({
      elapsedMs: visual.rankElapsedMs,
      position,
      reducedMotion: false,
      size,
    });
    if (number === null) {
      return;
    }
    context.font = `500 ${size}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = `rgb(${participant.color.r} ${participant.color.g} ${participant.color.b} / ${number.alpha / 255})`;
    context.fillText(String(participant.rank), number.x, number.y);
  });
}

function participantColor(
  visual: ParticipantVisual,
  snapshot: Readonly<ChooserSnapshot>,
  reducedMotion: boolean,
) {
  const participant = visual.participant;
  if (
    snapshot.selectionMode === "group" &&
    participant.state === "grouped" &&
    participant.targetColor !== undefined
  ) {
    return chooserGroupColorAt({
      elapsedMs: visual.groupElapsedMs,
      reducedMotion,
      targetColor: participant.targetColor,
    });
  }
  return participant.color;
}

function renderedPosition(
  position: Readonly<{ x: number; y: number }>,
  source: Readonly<ChooserSurfaceSize> | null,
  surface: Readonly<ChooserSurfaceSize>,
) {
  if (
    source === null ||
    (source.width === surface.width && source.height === surface.height)
  ) {
    return position;
  }
  return scaleChooserPosition(position, source, surface);
}

function stableRingPhases(id: string) {
  const hash = stableHash(id);
  return {
    ringStartDegrees: hash % 360,
    ringSweepStartDegrees: -(90 + ((hash >>> 9) % 271)),
  };
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function chooserLifetime(
  settings: Readonly<ChooserSettings>,
  mode: ChooserSnapshot["selectionMode"],
) {
  const lifetime =
    mode === "single"
      ? settings.singleLifetimeMs
      : mode === "group"
        ? settings.groupLifetimeMs
        : settings.orderLifetimeMs;
  return Number.isFinite(lifetime) ? Math.max(0, lifetime) : 0;
}

function moveTowards(current: number, target: number, amount: number) {
  if (current < target) {
    return Math.min(target, current + amount);
  }
  return Math.max(target, current - amount);
}

function mixColor(
  from: Readonly<ChooserColor>,
  to: Readonly<ChooserColor>,
  amount: number,
): ChooserColor {
  const progress = Math.max(0, Math.min(1, amount));
  return {
    r: Math.round(from.r + (to.r - from.r) * progress),
    g: Math.round(from.g + (to.g - from.g) * progress),
    b: Math.round(from.b + (to.b - from.b) * progress),
  };
}

function rgb(color: Readonly<ChooserColor>) {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function normalizedDevicePixelRatio() {
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function addMediaListener(query: MediaQueryList, listener: () => void) {
  query.addEventListener("change", listener);
}

function removeMediaListener(query: MediaQueryList, listener: () => void) {
  query.removeEventListener("change", listener);
}
