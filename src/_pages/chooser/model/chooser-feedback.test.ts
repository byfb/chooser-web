// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import {
  CHOOSER_SOUND_CUES,
  createChooserFeedback,
  createChooserSound,
  type ChooserAudioBuffer,
  type ChooserAudioBufferSource,
  type ChooserAudioContext,
} from "./chooser-feedback";

describe("Chooser synthesized feedback", () => {
  it.each(CHOOSER_SOUND_CUES)(
    "creates a finite, bounded %s cue lasting 40–300 ms",
    (cue) => {
      const sound = createChooserSound(cue, 48_000);
      const durationMs = (sound.samples.length / sound.sampleRate) * 1000;
      const peak = sound.samples.reduce(
        (maximum, sample) => Math.max(maximum, Math.abs(sample)),
        0,
      );

      expect(durationMs).toBeGreaterThanOrEqual(40);
      expect(durationMs).toBeLessThanOrEqual(300);
      expect(peak).toBeLessThanOrEqual(0.9);
      expect(sound.samples.every(Number.isFinite)).toBe(true);
    },
  );

  it("gives down, up, and chosen audibly distinct deterministic signatures", () => {
    const signatures = CHOOSER_SOUND_CUES.map((cue) => {
      const sound = createChooserSound(cue, 8_000);
      return `${sound.samples.length}:${Array.from(sound.samples.slice(0, 320))
        .map((sample) => sample.toFixed(4))
        .join(",")}`;
    });

    expect(new Set(signatures)).toHaveLength(CHOOSER_SOUND_CUES.length);
    expect(createChooserSound("down", 8_000).samples).toEqual(
      createChooserSound("down", 8_000).samples,
    );
  });

  it("creates one lazy context, resumes only trusted interactions, and plays once running", async () => {
    const harness = createAudioHarness("suspended");
    const feedback = createChooserFeedback({
      createAudioContext: harness.createContext,
      isDocumentVisible: () => true,
    });

    feedback.playSound("down");
    expect(harness.createdContexts).toBe(1);
    expect(harness.resume).not.toHaveBeenCalled();
    expect(harness.sources).toHaveLength(0);

    feedback.unlockFromInteraction(false);
    expect(harness.resume).not.toHaveBeenCalled();

    feedback.unlockFromInteraction(true);
    expect(harness.resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    feedback.playSound("down");
    feedback.playSound("up");
    expect(harness.createdContexts).toBe(1);
    expect(harness.sources).toHaveLength(2);
    expect(harness.sources.every((source) => source.started)).toBe(true);
  });

  it("never creates or resumes audio while hidden and retries when visible", () => {
    const harness = createAudioHarness("suspended");
    let visible = false;
    const feedback = createChooserFeedback({
      createAudioContext: harness.createContext,
      isDocumentVisible: () => visible,
    });

    feedback.unlockFromInteraction(true);
    expect(harness.createdContexts).toBe(0);
    expect(harness.resume).not.toHaveBeenCalled();

    visible = true;
    feedback.unlockFromInteraction(true);
    expect(harness.createdContexts).toBe(1);
    expect(harness.resume).toHaveBeenCalledTimes(1);
  });

  it("swallows resume, synthesis, playback, and close failures without blocking retries", async () => {
    const harness = createAudioHarness("suspended");
    harness.resume.mockRejectedValueOnce(new Error("locked"));
    const feedback = createChooserFeedback({
      createAudioContext: harness.createContext,
      isDocumentVisible: () => true,
    });

    expect(() => feedback.unlockFromInteraction(true)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    feedback.unlockFromInteraction(true);
    expect(harness.resume).toHaveBeenCalledTimes(2);

    harness.context.state = "running";
    harness.createBuffer.mockImplementationOnce(() => {
      throw new Error("buffer failure");
    });
    expect(() => feedback.playSound("chosen")).not.toThrow();
    harness.createBufferSource.mockImplementationOnce(() => {
      throw new Error("source failure");
    });
    expect(() => feedback.playSound("chosen")).not.toThrow();

    harness.close.mockRejectedValueOnce(new Error("close failure"));
    expect(() => feedback.destroy()).not.toThrow();
    await Promise.resolve();
  });

  it("caches one audio buffer per cue while creating a source for every play", () => {
    const harness = createAudioHarness("running");
    const feedback = createChooserFeedback({
      createAudioContext: harness.createContext,
      isDocumentVisible: () => true,
    });

    feedback.playSound("chosen");
    feedback.playSound("chosen");

    expect(harness.createBuffer).toHaveBeenCalledTimes(1);
    expect(harness.createBufferSource).toHaveBeenCalledTimes(2);
  });

  it("keeps absent audio and hidden, missing, false, or throwing vibration harmless", () => {
    const vibration = vi
      .fn<(durationMs: 40 | 100) => boolean>()
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error("denied");
      });
    let visible = false;
    const feedback = createChooserFeedback({
      createAudioContext: () => null,
      isDocumentVisible: () => visible,
      vibrate: vibration,
    });

    expect(() => feedback.playSound("down")).not.toThrow();
    feedback.vibrate(40);
    expect(vibration).not.toHaveBeenCalled();

    visible = true;
    expect(() => feedback.vibrate(40)).not.toThrow();
    expect(() => feedback.vibrate(100)).not.toThrow();
    expect(vibration).toHaveBeenNthCalledWith(1, 40);
    expect(vibration).toHaveBeenNthCalledWith(2, 100);

    const unsupported = createChooserFeedback({
      createAudioContext: () => null,
      isDocumentVisible: () => true,
    });
    expect(() => unsupported.vibrate(100)).not.toThrow();
  });
});

function createAudioHarness(initialState: string) {
  const sources: Array<ChooserAudioBufferSource & { started: boolean }> = [];
  let createdContexts = 0;
  const close = vi.fn(async () => undefined);
  const createBuffer = vi.fn(
    (_channels: number, length: number, sampleRate: number) =>
      ({
        length,
        sampleRate,
        copyToChannel: vi.fn(),
      }) satisfies ChooserAudioBuffer,
  );
  const createBufferSource = vi.fn(() => {
    const source: ChooserAudioBufferSource & { started: boolean } = {
      buffer: null,
      started: false,
      connect: vi.fn(),
      start() {
        this.started = true;
      },
    };
    sources.push(source);
    return source;
  });
  const context: ChooserAudioContext & { state: string } = {
    state: initialState,
    sampleRate: 48_000,
    destination: {},
    close,
    createBuffer,
    createBufferSource,
    resume: async () => {
      context.state = "running";
    },
  };
  const resume = vi.fn(context.resume);
  context.resume = resume;
  const createContext = vi.fn(() => {
    createdContexts += 1;
    return context;
  });

  return {
    context,
    close,
    createContext,
    createBuffer,
    createBufferSource,
    get createdContexts() {
      return createdContexts;
    },
    resume,
    sources,
  };
}
