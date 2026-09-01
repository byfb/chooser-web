// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

/** The short, synthesized cues used by the Chooser interaction. */
export const CHOOSER_SOUND_CUES = ["down", "up", "chosen"] as const;

export type ChooserSoundCue = (typeof CHOOSER_SOUND_CUES)[number];

/** The small part of AudioBuffer needed by the feedback boundary. */
export interface ChooserAudioBuffer {
  readonly length: number;
  readonly sampleRate: number;
  copyToChannel(
    source: Float32Array,
    channelNumber: number,
    bufferOffset?: number,
  ): void;
}

/** The small part of AudioBufferSourceNode needed by the feedback boundary. */
export interface ChooserAudioBufferSource {
  buffer: ChooserAudioBuffer | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
}

/** The injected AudioContext surface used by Chooser feedback. */
export interface ChooserAudioContext {
  readonly destination: unknown;
  readonly sampleRate: number;
  readonly state: string;
  close(): Promise<void> | void;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): ChooserAudioBuffer;
  createBufferSource(): ChooserAudioBufferSource;
  resume(): Promise<void> | void;
}

export interface ChooserSound {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export interface ChooserFeedbackOptions {
  readonly createAudioContext?: () => ChooserAudioContext | null;
  readonly isDocumentVisible?: () => boolean;
  readonly vibrate?: (durationMs: 40 | 100) => boolean;
}

export interface ChooserFeedback {
  destroy(): void;
  playSound(cue: ChooserSoundCue): void;
  unlockFromInteraction(isTrustedInteraction: boolean): void;
  vibrate(durationMs: 40 | 100): void;
}

interface SoundDefinition {
  readonly durationMs: number;
  readonly endFrequencyHz: number;
  readonly harmonics: readonly number[];
  readonly startFrequencyHz: number;
}

const DEFAULT_SAMPLE_RATE = 48_000;
const MAX_SAMPLE_RATE = 192_000;
const MIN_SAMPLE_RATE = 1_000;
const SOUND_PEAK = 0.78;

const SOUND_DEFINITIONS: Record<ChooserSoundCue, SoundDefinition> = {
  chosen: {
    durationMs: 220,
    endFrequencyHz: 680,
    harmonics: [1, 2, 3],
    startFrequencyHz: 440,
  },
  down: {
    durationMs: 80,
    endFrequencyHz: 230,
    harmonics: [1, 2],
    startFrequencyHz: 540,
  },
  up: {
    durationMs: 100,
    endFrequencyHz: 620,
    harmonics: [1, 3],
    startFrequencyHz: 260,
  },
};

/**
 * Generate one deterministic original Web Audio cue.
 *
 * The waveforms intentionally live in source instead of using copied audio
 * recordings. A short attack and release keep each cue bounded while the
 * frequency sweep and harmonic recipe make the three cues distinguishable.
 */
export function createChooserSound(
  cue: ChooserSoundCue,
  sampleRate: number,
): ChooserSound {
  const definition = SOUND_DEFINITIONS[cue];
  const safeSampleRate = normalizeSampleRate(sampleRate);
  const sampleCount = Math.max(
    1,
    Math.round((safeSampleRate * definition.durationMs) / 1_000),
  );
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = sampleCount === 1 ? 1 : index / (sampleCount - 1);
    const frequency =
      definition.startFrequencyHz +
      (definition.endFrequencyHz - definition.startFrequencyHz) * progress;
    const timeSeconds = index / safeSampleRate;
    const phase =
      2 *
      Math.PI *
      (definition.startFrequencyHz * timeSeconds +
        ((definition.endFrequencyHz - definition.startFrequencyHz) *
          timeSeconds *
          timeSeconds) /
          (2 * (definition.durationMs / 1_000)));
    const envelope = createEnvelope(progress);
    const harmonicCount = definition.harmonics.length;
    let waveform = 0;

    for (
      let harmonicIndex = 0;
      harmonicIndex < harmonicCount;
      harmonicIndex += 1
    ) {
      const harmonic = definition.harmonics[harmonicIndex] ?? 1;
      const harmonicWeight = 1 / (harmonicIndex + 1);
      waveform += Math.sin(phase * harmonic) * harmonicWeight;
    }

    const normalizedWaveform = waveform / harmonicCount;
    // Read `frequency` in the recipe so the sweep remains explicit and easy
    // to audit; the phase above is the integrated sweep used for the sample.
    const highFrequencyAccent = Math.sin(2 * Math.PI * frequency * timeSeconds);
    samples[index] = Math.fround(
      Math.max(
        -SOUND_PEAK,
        Math.min(
          SOUND_PEAK,
          envelope *
            SOUND_PEAK *
            (0.82 * normalizedWaveform + 0.18 * highFrequencyAccent),
        ),
      ),
    );
  }

  return { sampleRate: safeSampleRate, samples };
}

/**
 * Create the best-effort browser feedback boundary.
 *
 * The boundary owns one lazy AudioContext and never lets browser media or
 * haptic failures escape into the selection state machine.
 */
export function createChooserFeedback(
  options: ChooserFeedbackOptions = {},
): ChooserFeedback {
  const createAudioContext =
    options.createAudioContext ?? getBrowserAudioContextFactory();
  const isDocumentVisible =
    options.isDocumentVisible ?? getBrowserVisibilityReader();
  const vibrate = options.vibrate ?? getBrowserVibrate();
  const buffers = new Map<ChooserSoundCue, ChooserAudioBuffer>();

  let audioContext: ChooserAudioContext | null | undefined;
  let audioContextFactoryUsed = false;
  let resumeInFlight = false;
  let destroyed = false;

  const feedback: ChooserFeedback = {
    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      buffers.clear();
      const context = audioContext;
      audioContext = null;
      resumeInFlight = false;

      if (!context) {
        return;
      }

      try {
        void Promise.resolve(context.close()).catch(() => undefined);
      } catch {
        // Browser shutdown is best effort and must not affect the chooser.
      }
    },

    playSound(cue) {
      if (destroyed) {
        return;
      }

      const context = getAudioContext();
      if (!context || !isRunning(context)) {
        return;
      }

      try {
        let buffer = buffers.get(cue);
        if (!buffer) {
          const sound = createChooserSound(cue, context.sampleRate);
          buffer = context.createBuffer(
            1,
            sound.samples.length,
            sound.sampleRate,
          );
          buffer.copyToChannel(sound.samples, 0);
          buffers.set(cue, buffer);
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
      } catch {
        // A blocked/partially implemented audio surface must remain harmless.
      }
    },

    unlockFromInteraction(isTrustedInteraction) {
      if (destroyed || !isTrustedInteraction) {
        return;
      }
      try {
        if (!isDocumentVisible()) {
          return;
        }
      } catch {
        return;
      }

      const context = getAudioContext();
      if (!context || isRunning(context) || resumeInFlight) {
        return;
      }

      resumeInFlight = true;
      try {
        void Promise.resolve(context.resume())
          .catch(() => undefined)
          .finally(() => {
            resumeInFlight = false;
          });
      } catch {
        resumeInFlight = false;
      }
    },

    vibrate(durationMs) {
      if (destroyed || !vibrate) {
        return;
      }

      try {
        if (!isDocumentVisible()) {
          return;
        }
        void vibrate(durationMs);
      } catch {
        // Vibration is an optional, visibility-gated enhancement.
      }
    },
  };

  function getAudioContext(): ChooserAudioContext | null {
    if (audioContextFactoryUsed || destroyed) {
      return audioContext ?? null;
    }

    audioContextFactoryUsed = true;
    try {
      audioContext = createAudioContext?.() ?? null;
    } catch {
      audioContext = null;
    }

    return audioContext;
  }

  function isRunning(context: ChooserAudioContext): boolean {
    try {
      return context.state === "running";
    } catch {
      return false;
    }
  }

  return feedback;
}

function createEnvelope(progress: number): number {
  const attack = Math.min(1, progress / 0.08);
  const release = Math.min(1, (1 - progress) / 0.18);
  return Math.max(0, Math.min(1, attack * release));
}

function normalizeSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return DEFAULT_SAMPLE_RATE;
  }

  return Math.min(
    MAX_SAMPLE_RATE,
    Math.max(MIN_SAMPLE_RATE, Math.round(sampleRate)),
  );
}

function getBrowserAudioContextFactory(): () => ChooserAudioContext | null {
  return () => {
    if (typeof window === "undefined") {
      return null;
    }

    const AudioContextConstructor =
      window.AudioContext ??
      (
        window as Window &
          typeof globalThis & {
            webkitAudioContext?: typeof AudioContext;
          }
      ).webkitAudioContext;

    if (!AudioContextConstructor) {
      return null;
    }

    return new AudioContextConstructor() as unknown as ChooserAudioContext;
  };
}

function getBrowserVisibilityReader(): () => boolean {
  return () =>
    typeof document === "undefined" || document.visibilityState === "visible";
}

function getBrowserVibrate(): ((durationMs: 40 | 100) => boolean) | undefined {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.vibrate !== "function"
  ) {
    return undefined;
  }

  return (durationMs) => navigator.vibrate(durationMs);
}
