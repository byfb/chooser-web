// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  createChooserCanvasViewport,
  chooserGroupColorAt,
  chooserOrderNumberAt,
  chooserParticipantHitRadius,
  chooserParticipantRadius,
  chooserResetRadius,
  chooserSingleMaskRadius,
  clientToChooserPosition,
  configureChooserCanvasSurface,
  createChooserParticipantGeometry,
  farthestChooserCornerRadius,
  scaleChooserPosition,
} from "./chooser-rendering";

describe("Chooser renderer geometry", () => {
  it.each([
    { cssHeight: 568, cssWidth: 320, dpr: 2 },
    { cssHeight: 800, cssWidth: 360, dpr: 3 },
    { cssHeight: 844, cssWidth: 390, dpr: 3 },
    { cssHeight: 390, cssWidth: 844, dpr: 3 },
    { cssHeight: 720, cssWidth: 1280, dpr: 1 },
    { cssHeight: 900, cssWidth: 1440, dpr: 2 },
  ])(
    "maps $cssWidth×$cssHeight CSS pixels at DPR $dpr to a sharp backing bitmap",
    ({ cssHeight, cssWidth, dpr }) => {
      expect(createChooserCanvasViewport({ cssHeight, cssWidth, dpr })).toEqual(
        {
          bitmapHeight: cssHeight * dpr,
          bitmapWidth: cssWidth * dpr,
          cssHeight,
          cssWidth,
          dpr,
        },
      );
    },
  );

  it("rescales a settled participant proportionally with the surface", () => {
    expect(
      scaleChooserPosition(
        { x: 195, y: 422 },
        { height: 844, width: 390 },
        { height: 390, width: 844 },
      ),
    ).toEqual({ x: 422, y: 195 });
  });

  it("covers the farthest viewport corner with a Single mask", () => {
    expect(
      farthestChooserCornerRadius({ x: 10, y: 20 }, { height: 80, width: 100 }),
    ).toBeCloseTo(108.1665382639, 10);
  });

  it("preserves the participant core, ring, and eight-percent pulse geometry", () => {
    const geometry = createChooserParticipantGeometry({
      circleSizePercent: 100,
      coreRadius: 50,
      elapsedMs: 261.7993877991,
      reducedMotion: false,
    });

    expect(geometry.nominalRadius).toBe(50);
    expect(geometry.outerRadius).toBeCloseTo(54, 10);
    expect(geometry.innerRadius).toBeCloseTo(32.4, 10);
    expect(geometry.strokeWidth).toBeCloseTo(10.26, 10);
    expect(
      createChooserParticipantGeometry({
        circleSizePercent: 100,
        coreRadius: 50,
        elapsedMs: 261.7993877991,
        reducedMotion: true,
      }),
    ).toEqual({
      innerRadius: 30,
      nominalRadius: 50,
      outerRadius: 50,
      strokeWidth: 9.5,
    });
  });

  it("blends Group participants from white to their target in 100 ms", () => {
    expect(
      chooserGroupColorAt({
        elapsedMs: 0,
        reducedMotion: false,
        targetColor: { r: 100, g: 150, b: 200 },
      }),
    ).toEqual({ r: 255, g: 255, b: 255 });
    expect(
      chooserGroupColorAt({
        elapsedMs: 50,
        reducedMotion: false,
        targetColor: { r: 100, g: 150, b: 200 },
      }),
    ).toEqual({ r: 178, g: 203, b: 228 });
    expect(
      chooserGroupColorAt({
        elapsedMs: 100,
        reducedMotion: false,
        targetColor: { r: 100, g: 150, b: 200 },
      }),
    ).toEqual({ r: 100, g: 150, b: 200 });
    expect(
      chooserGroupColorAt({
        elapsedMs: 0,
        reducedMotion: true,
        targetColor: { r: 100, g: 150, b: 200 },
      }),
    ).toEqual({ r: 100, g: 150, b: 200 });
  });

  it("accelerates the Single reveal without shrinking below its circle-size floor", () => {
    expect(
      chooserSingleMaskRadius({
        circleSizePercent: 100,
        elapsedMs: 0,
        initialRadius: 500,
      }),
    ).toBe(500);
    expect(
      chooserSingleMaskRadius({
        circleSizePercent: 100,
        elapsedMs: 100,
        initialRadius: 500,
      }),
    ).toBe(200);
    expect(
      chooserSingleMaskRadius({
        circleSizePercent: 100,
        elapsedMs: 200,
        initialRadius: 500,
      }),
    ).toBe(105);
  });

  it("uses the configured lifetime for teardown while reduced-motion results stay static", () => {
    expect(
      chooserResetRadius({
        elapsedMs: 250,
        lifetimeMs: 1000,
        reducedMotion: false,
        startRadius: 75,
      }),
    ).toBe(56.25);
    expect(
      chooserResetRadius({
        elapsedMs: 1000,
        lifetimeMs: 1000,
        reducedMotion: false,
        startRadius: 75,
      }),
    ).toBe(0);
    expect(
      chooserResetRadius({
        elapsedMs: 999,
        lifetimeMs: 1000,
        reducedMotion: true,
        startRadius: 75,
      }),
    ).toBe(75);
    expect(
      chooserResetRadius({
        elapsedMs: 1000,
        lifetimeMs: 1000,
        reducedMotion: true,
        startRadius: 75,
      }),
    ).toBe(0);
  });

  it("moves and fades a transient Order number and suppresses it for reduced motion", () => {
    const number = chooserOrderNumberAt({
      elapsedMs: 1000,
      position: { x: 100, y: 100 },
      reducedMotion: false,
      size: 50,
    });

    expect(number?.alpha).toBeCloseTo(215, 10);
    expect(number?.x).toBeCloseTo(101.7640001007, 10);
    expect(number?.y).toBeCloseTo(25, 10);
    expect(
      chooserOrderNumberAt({
        elapsedMs: 1000,
        position: { x: 100, y: 100 },
        reducedMotion: true,
        size: 50,
      }),
    ).toBeNull();
    expect(
      chooserOrderNumberAt({
        elapsedMs: 3000,
        position: { x: 100, y: 100 },
        reducedMotion: false,
        size: 50,
      }),
    ).toBeNull();
  });

  it("uses one CSS-pixel geometry for drawing, pointer coordinates, and hit testing", () => {
    expect(chooserParticipantRadius(50)).toBe(25);
    expect(chooserParticipantRadius(100)).toBe(50);
    expect(chooserParticipantRadius(150)).toBe(75);
    expect(chooserParticipantHitRadius(100)).toBe(58);
    expect(
      clientToChooserPosition(
        { clientX: 152, clientY: 263 },
        { left: 12, top: 23 },
      ),
    ).toEqual({ x: 140, y: 240 });
  });

  it("restores the Canvas transform and drawing state after backing resize", () => {
    const canvas = { height: 10, width: 10 };
    const transforms: number[][] = [];
    const context = {
      lineCap: "butt" as CanvasLineCap,
      lineJoin: "miter" as CanvasLineJoin,
      setTransform: (...values: number[]) => transforms.push(values),
    };

    expect(
      configureChooserCanvasSurface(canvas, context, {
        cssHeight: 844,
        cssWidth: 390,
        dpr: 3,
      }),
    ).toEqual({
      bitmapHeight: 2532,
      bitmapWidth: 1170,
      cssHeight: 844,
      cssWidth: 390,
      dpr: 3,
    });
    expect(canvas).toEqual({ height: 2532, width: 1170 });
    expect(context).toMatchObject({ lineCap: "round", lineJoin: "round" });
    expect(transforms).toEqual([[3, 0, 0, 3, 0, 0]]);
  });
});
