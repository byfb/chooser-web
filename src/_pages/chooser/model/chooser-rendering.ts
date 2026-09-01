// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChooserColor, ChooserPosition } from "./chooser-session";

export interface ChooserSurfaceSize {
  readonly height: number;
  readonly width: number;
}

export interface ChooserCanvasViewportInput {
  readonly cssHeight: number;
  readonly cssWidth: number;
  readonly dpr: number;
}

export interface ChooserCanvasViewport extends ChooserCanvasViewportInput {
  readonly bitmapHeight: number;
  readonly bitmapWidth: number;
}

export interface ChooserCanvasSurface {
  height: number;
  width: number;
}

export interface ChooserCanvasDrawingState {
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
}

export interface ChooserParticipantGeometryInput {
  readonly circleSizePercent: number;
  readonly coreRadius: number;
  readonly elapsedMs: number;
  readonly reducedMotion: boolean;
}

export interface ChooserGroupColorInput {
  readonly elapsedMs: number;
  readonly reducedMotion: boolean;
  readonly targetColor: Readonly<ChooserColor>;
}

export interface ChooserSingleMaskInput {
  readonly circleSizePercent: number;
  readonly elapsedMs: number;
  readonly initialRadius: number;
}

export interface ChooserResetRadiusInput {
  readonly elapsedMs: number;
  readonly lifetimeMs: number;
  readonly reducedMotion: boolean;
  readonly startRadius: number;
}

export interface ChooserOrderNumberInput {
  readonly elapsedMs: number;
  readonly position: Readonly<ChooserPosition>;
  readonly reducedMotion: boolean;
  readonly size: number;
}

export function createChooserCanvasViewport({
  cssHeight,
  cssWidth,
  dpr,
}: Readonly<ChooserCanvasViewportInput>): ChooserCanvasViewport {
  return Object.freeze({
    bitmapHeight: Math.round(cssHeight * dpr),
    bitmapWidth: Math.round(cssWidth * dpr),
    cssHeight,
    cssWidth,
    dpr,
  });
}

export function configureChooserCanvasSurface(
  canvas: ChooserCanvasSurface,
  context: ChooserCanvasDrawingState,
  input: Readonly<ChooserCanvasViewportInput>,
) {
  const viewport = createChooserCanvasViewport(input);
  if (canvas.width !== viewport.bitmapWidth) {
    canvas.width = viewport.bitmapWidth;
  }
  if (canvas.height !== viewport.bitmapHeight) {
    canvas.height = viewport.bitmapHeight;
  }
  context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
  return viewport;
}

export function scaleChooserPosition(
  position: Readonly<ChooserPosition>,
  from: Readonly<ChooserSurfaceSize>,
  to: Readonly<ChooserSurfaceSize>,
): ChooserPosition {
  return Object.freeze({
    x: position.x * (to.width / from.width),
    y: position.y * (to.height / from.height),
  });
}

export function chooserParticipantRadius(circleSizePercent: number) {
  return 50 * (circleSizePercent / 100);
}

export function chooserParticipantHitRadius(circleSizePercent: number) {
  return chooserParticipantRadius(circleSizePercent) + 8;
}

export function clientToChooserPosition(
  client: Readonly<{ clientX: number; clientY: number }>,
  rect: Readonly<{ left: number; top: number }>,
): ChooserPosition {
  return Object.freeze({
    x: client.clientX - rect.left,
    y: client.clientY - rect.top,
  });
}

export function farthestChooserCornerRadius(
  position: Readonly<ChooserPosition>,
  surface: Readonly<ChooserSurfaceSize>,
) {
  return Math.max(
    Math.hypot(position.x, position.y),
    Math.hypot(surface.width - position.x, position.y),
    Math.hypot(position.x, surface.height - position.y),
    Math.hypot(surface.width - position.x, surface.height - position.y),
  );
}

export function createChooserParticipantGeometry({
  circleSizePercent,
  coreRadius,
  elapsedMs,
  reducedMotion,
}: Readonly<ChooserParticipantGeometryInput>) {
  const nominalRadius = chooserParticipantRadius(circleSizePercent);
  const pulse = reducedMotion
    ? 0
    : nominalRadius * 0.08 * Math.sin(elapsedMs * 0.006);
  const outerRadius = Math.max(0, coreRadius + pulse);
  return Object.freeze({
    innerRadius: outerRadius * 0.6,
    nominalRadius,
    outerRadius,
    strokeWidth: outerRadius * 0.19,
  });
}

export function chooserGroupColorAt({
  elapsedMs,
  reducedMotion,
  targetColor,
}: Readonly<ChooserGroupColorInput>): ChooserColor {
  const progress = reducedMotion
    ? 1
    : Math.max(0, Math.min(1, elapsedMs / 100));
  return Object.freeze({
    r: Math.round(255 + (targetColor.r - 255) * progress),
    g: Math.round(255 + (targetColor.g - 255) * progress),
    b: Math.round(255 + (targetColor.b - 255) * progress),
  });
}

export function chooserSingleMaskRadius({
  circleSizePercent,
  elapsedMs,
  initialRadius,
}: Readonly<ChooserSingleMaskInput>) {
  const minimumRadius = 105 * (circleSizePercent / 100);
  const elapsed = Math.max(0, elapsedMs);
  return Math.max(
    minimumRadius,
    initialRadius - elapsed - 0.02 * elapsed * elapsed,
  );
}

export function chooserResetRadius({
  elapsedMs,
  lifetimeMs,
  reducedMotion,
  startRadius,
}: Readonly<ChooserResetRadiusInput>) {
  if (lifetimeMs <= 0 || elapsedMs >= lifetimeMs) {
    return 0;
  }
  if (reducedMotion) {
    return startRadius;
  }
  const progress = Math.max(0, elapsedMs) / lifetimeMs;
  return startRadius * (1 - progress);
}

export function chooserOrderNumberAt({
  elapsedMs,
  position,
  reducedMotion,
  size,
}: Readonly<ChooserOrderNumberInput>) {
  if (reducedMotion) {
    return null;
  }

  const elapsed = Math.max(0, elapsedMs);
  const alpha = 255 - 0.00004 * elapsed * elapsed;
  if (alpha <= 0) {
    return null;
  }

  return Object.freeze({
    alpha,
    x: position.x + Math.sin(elapsed * 0.003) * size * 0.25,
    y: position.y - size - size * elapsed * 0.0005,
  });
}
