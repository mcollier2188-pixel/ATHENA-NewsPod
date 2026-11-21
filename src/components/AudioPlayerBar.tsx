import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Gauge,
  Maximize2,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import type { AudioBriefing } from '../types';
import { formatClock } from '../utils/wavUtils';
import { SegmentWaveformScrubber } from './SegmentWaveformScrubber';

export type SleepTimerMode = 'off' | 'countdown' | 'end-of-chapter';

interface AudioAnalyserHandle {
  ctx: AudioContext;
  analyser: AnalyserNode;
  source: MediaElementAudioSourceNode;
}

// WeakMap prevents calling createMediaElementSource twice on the same <audio> element
// across AudioPlayerBar remounts (e.g., toggling full-screen Spatial Immersive mode).
const AUDIO_ANALYSER_CACHE = new WeakMap<HTMLAudioElement, AudioAnalyserHandle>();

function getOrCreateAudioAnalyser(
  audioEl: HTMLAudioElement
): AudioAnalyserHandle | null {
  const existing = AUDIO_ANALYSER_CACHE.get(audioEl);
  if (existing) return existing;

  const AudioCtxCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtxCtor) return null;

  try {
    const ctx = new AudioCtxCtor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    const source = ctx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const handle: AudioAnalyserHandle = { ctx, analyser, source };
    AUDIO_ANALYSER_CACHE.set(audioEl, handle);
    return handle;
  } catch {
    return null;
  }
}

const WAVEFORM_BAR_COUNT = 18;

interface AudioPlayerBarProps {
  briefing: AudioBriefing;
  activeSegmentIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  audioElementRef?: RefObject<HTMLAudioElement | null>;
  sleepTimerMode: SleepTimerMode;
  sleepTimerRemainingSec: number | null;
  onSetSleepTimerMinutes: (minutes: number) => void;
  onSetSleepTimerEndOfChapter: () => void;
  onExtendSleepTimer: (extraMinutes: number) => void;
  onCancelSleepTimer: () => void;
  onTogglePlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipSeconds: (delta: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onCyclePlaybackRate: () => void;
  onOpenCommuteMode: () => void;
}

const SLEEP_PRESET_MINUTES = [5, 15, 30, 45, 60];

function formatPlaybackRate(rate: number): string {
  return Number.isInteger(rate) ? `${rate}.0x` : `${rate}x`;
}

export function formatSleepCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function AudioPlayerBar({
  briefing,
  activeSegmentIndex,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  audioElementRef,
  sleepTimerMode,
  sleepTimerRemainingSec,
  onSetSleepTimerMinutes,
  onSetSleepTimerEndOfChapter,
  onExtendSleepTimer,
  onCancelSleepTimer,
  onTogglePlayPause,
  onSeek,
  onSkipSeconds,
  onPrevChapter,
  onNextChapter,
  onCyclePlaybackRate,
  onOpenCommuteMode,
}: AudioPlayerBarProps) {
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  const sleepMenuRef = useRef<HTMLDivElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const smoothedLevelsRef = useRef<Float32Array>(
    new Float32Array(WAVEFORM_BAR_COUNT)
  );

  // Subtle Web Audio API frequency-reactive waveform animation
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = 84;
    const cssHeight = 24;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let handle: AudioAnalyserHandle | null = null;
    const audioEl = audioElementRef?.current ?? null;
    if (isPlaying && audioEl) {
      handle = getOrCreateAudioAnalyser(audioEl);
      if (handle && handle.ctx.state === 'suspended') {
        handle.ctx.resume().catch(() => {});
      }
    }

    const freqData = handle
      ? new Uint8Array(handle.analyser.frequencyBinCount)
      : null;
    const levels = smoothedLevelsRef.current;
    let rafId = 0;

    const drawBars = (active: boolean) => {
      ctx2d.save();
      ctx2d.scale(dpr, dpr);
      ctx2d.clearRect(0, 0, cssWidth, cssHeight);

      const gap = 2.5;
      const barWidth =
        (cssWidth - gap * (WAVEFORM_BAR_COUNT - 1)) / WAVEFORM_BAR_COUNT;
      const centerY = cssHeight / 2;

      for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
        const lvl = levels[i];
        // Gentle bell envelope so outer bars stay subtly tapered
        const normPos = (i / (WAVEFORM_BAR_COUNT - 1)) * 2 - 1;
        const envelope = 1 - 0.32 * normPos * normPos;
        const barH = Math.max(2.5, Math.min(cssHeight - 2, (2.5 + lvl * 19.5) * envelope));
        const x = i * (barWidth + gap);
        const y = centerY - barH / 2;

        const alpha = active ? 0.34 + lvl * 0.62 : 0.22;
        ctx2d.fillStyle =
          lvl > 0.55
            ? `rgba(103, 232, 249, ${alpha.toFixed(2)})`
            : `rgba(34, 211, 238, ${alpha.toFixed(2)})`;

        ctx2d.beginPath();
        ctx2d.roundRect(x, y, barWidth, barH, barWidth / 2);
        ctx2d.fill();
      }
      ctx2d.restore();
    };

    if (prefersReducedMotion) {
      for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
        levels[i] = isPlaying ? 0.28 + ((i * 7) % 5) * 0.06 : 0.04;
      }
      drawBars(isPlaying);
      return;
    }

    let cancelled = false;
    const renderFrame = () => {
      if (cancelled) return;

      if (isPlaying && handle && freqData) {
        handle.analyser.getByteFrequencyData(freqData);
        // Focus across vocal frequency bins (bins 1..34 of 64) for crisp speech reactivity
        const usableBins = Math.min(34, freqData.length - 1);
        for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
          const binIdx =
            1 + Math.floor((i / WAVEFORM_BAR_COUNT) * Math.max(1, usableBins));
          const nextBin = Math.min(freqData.length - 1, binIdx + 1);
          const raw = ((freqData[binIdx] + freqData[nextBin]) * 0.5) / 255;
          // Subtle response curve so quiet speech registers gently without clipping
          const target = Math.pow(raw, 0.85);
          levels[i] += (target - levels[i]) * 0.28;
        }
        drawBars(true);
        rafId = requestAnimationFrame(renderFrame);
      } else {
        let maxRemaining = 0;
        for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
          levels[i] *= 0.82;
          if (levels[i] < 0.01) levels[i] = 0;
          if (levels[i] > maxRemaining) maxRemaining = levels[i];
        }
        drawBars(maxRemaining > 0.02);
        if (maxRemaining > 0.02) {
          rafId = requestAnimationFrame(renderFrame);
        }
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, audioElementRef, activeSegmentIndex]);

  useEffect(() => {
    if (!sleepMenuOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        sleepMenuRef.current &&
        !sleepMenuRef.current.contains(e.target as Node)
      ) {
        setSleepMenuOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSleepMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sleepMenuOpen]);

  const segment = briefing.segments[activeSegmentIndex];
  if (!segment) return null;

  const formattedRate = formatPlaybackRate(playbackRate);
  const isModifiedSpeed = playbackRate !== 1;
  const isSleepActive = sleepTimerMode !== 'off';

  const sleepButtonLabel =
    sleepTimerMode === 'countdown' && sleepTimerRemainingSec !== null
      ? formatSleepCountdown(sleepTimerRemainingSec)
      : sleepTimerMode === 'end-of-chapter'
        ? 'Ch. end'
        : 'Sleep';

  return (
    <div
      role="region"
      aria-label="Audio briefing player"
      className="fixed bottom-0 inset-x-0 z-40 bg-[#11141A]/98 backdrop-blur-md border-t border-[#22D3EE]/35 shadow-[0_-6px_28px_rgba(0,0,0,0.45)]"
    >
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-2.5 flex items-center justify-between gap-3 sm:gap-4">
        {/* Track Info + Subtle Frequency-Reactive Waveform */}
        <div className="min-w-0 flex-1 max-w-[320px] flex items-center gap-3">
          <canvas
            ref={waveformCanvasRef}
            aria-hidden="true"
            className="hidden sm:block w-[84px] h-6 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] text-[#22D3EE] tabular-nums truncate">
              Chapter {activeSegmentIndex + 1} of {briefing.segments.length} ·{' '}
              {segment.category}
              <span className="md:hidden text-[#A0AABB]">
                {' '}
                · {formatClock(currentTime)}
              </span>
            </p>
            <p className="text-sm font-medium text-[#F5F7FA] truncate">
              {segment.title}
            </p>
          </div>
        </div>

        {/* Center Transport Controls + Scrubber */}
        <div className="flex-1 max-w-xl flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={onPrevChapter}
              disabled={activeSegmentIndex === 0}
              aria-label="Previous chapter"
              className="w-8 h-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => onSkipSeconds(-15)}
              aria-label="Rewind 15 seconds"
              className="hidden sm:inline-flex w-8 h-8 items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
              title="Rewind 15s"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onTogglePlayPause}
              aria-label={isPlaying ? 'Pause briefing' : 'Play briefing'}
              className="w-10 h-10 rounded-full bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] inline-flex items-center justify-center transition-colors cursor-pointer shrink-0"
            >
              {isPlaying ? (
                <Pause className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4 ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onSkipSeconds(15)}
              aria-label="Forward 15 seconds"
              className="hidden sm:inline-flex w-8 h-8 items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
              title="Forward 15s"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onNextChapter}
              disabled={activeSegmentIndex >= briefing.segments.length - 1}
              aria-label="Next chapter"
              className="w-8 h-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
            >
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          {/* Mirrored Editorial Waveform Scrubber Row */}
          <div className="hidden md:flex w-full items-center gap-2.5">
            <span className="font-mono text-[11px] text-[#A0AABB] tabular-nums w-9 text-right shrink-0">
              {formatClock(currentTime)}
            </span>
            <SegmentWaveformScrubber
              segmentId={segment.id}
              audioBase64={segment.audioBase64}
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              onSeek={onSeek}
            />
            <span className="font-mono text-[11px] text-[#A0AABB] tabular-nums w-9 shrink-0">
              {formatClock(duration)}
            </span>
          </div>
        </div>

        {/* Right Speed Readout + Sleep Timer + Commute Mode */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Speed Readout + Rate Toggle */}
          <div
            className={`inline-flex items-center rounded-md border transition-colors ${
              isModifiedSpeed
                ? 'bg-[#101B24] border-[#22D3EE]/60'
                : 'bg-[#0E1116] border-[#273040]'
            }`}
          >
            <div
              role="status"
              aria-live="polite"
              aria-label={`Current playback speed ${formattedRate}`}
              className="px-2.5 h-9 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-wider text-[#8C96A8]">
                Speed
              </span>
              <span
                className={`font-mono text-[13px] font-semibold tabular-nums ${
                  isModifiedSpeed ? 'text-[#22D3EE]' : 'text-[#F5F7FA]'
                }`}
              >
                {formattedRate}
              </span>
            </div>

            <span
              aria-hidden="true"
              className="w-px h-5 bg-[#273040] shrink-0"
            />

            <button
              type="button"
              onClick={onCyclePlaybackRate}
              aria-label={`Change playback speed (currently ${formattedRate})`}
              title={`Cycle playback speed (currently ${formattedRate})`}
              className="h-9 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#E4E9F1] hover:text-[#67E8F9] hover:bg-[#18212C] rounded-r-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Gauge className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
              <span>Rate</span>
            </button>
          </div>

          {/* Sleep Timer Trigger & Upward Popover */}
          <div ref={sleepMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setSleepMenuOpen((prev) => !prev)}
              aria-haspopup="dialog"
              aria-expanded={sleepMenuOpen}
              aria-label={
                isSleepActive
                  ? `Sleep timer active: ${sleepButtonLabel}. Click to adjust.`
                  : 'Set sleep timer'
              }
              title="Sleep timer"
              className={`h-9 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap tabular-nums cursor-pointer ${
                isSleepActive
                  ? 'bg-[#101B24] border-[#22D3EE]/65 text-[#22D3EE]'
                  : 'bg-[#0E1116] border-[#273040] text-[#E4E9F1] hover:border-[#22D3EE]/55 hover:text-[#67E8F9]'
              }`}
            >
              <Moon className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
              <span className={isSleepActive ? 'font-mono font-semibold' : 'hidden lg:inline'}>
                {sleepButtonLabel}
              </span>
            </button>

            {sleepMenuOpen && (
              <div
                role="dialog"
                aria-label="Sleep timer settings"
                className="absolute bottom-full right-0 mb-2.5 w-64 bg-[#13161C] border border-[#22D3EE]/50 rounded-lg shadow-2xl p-3.5 z-50"
              >
                <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#222833]">
                  <div className="flex items-center gap-1.5">
                    <Moon className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    <span className="text-xs font-semibold text-[#F5F7FA]">
                      Sleep Timer
                    </span>
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
                    {sleepTimerMode === 'countdown' && sleepTimerRemainingSec !== null
                      ? formatSleepCountdown(sleepTimerRemainingSec)
                      : sleepTimerMode === 'end-of-chapter'
                        ? 'End of chapter'
                        : 'Off'}
                  </span>
                </div>

                <p className="mt-2.5 text-[11px] text-[#8C96A8] leading-snug">
                  Automatically pause playback and save your exact listening position.
                </p>

                {/* Duration Presets */}
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  {SLEEP_PRESET_MINUTES.map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => {
                        onSetSleepTimerMinutes(mins);
                        setSleepMenuOpen(false);
                      }}
                      className="h-8 px-2 font-mono text-xs font-medium text-[#E4E9F1] bg-[#0E1116] border border-[#273040] hover:border-[#22D3EE] hover:text-[#67E8F9] hover:bg-[#14202C] rounded transition-colors tabular-nums cursor-pointer"
                    >
                      {mins} min
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      onSetSleepTimerEndOfChapter();
                      setSleepMenuOpen(false);
                    }}
                    className={`h-8 px-2 text-[11px] font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                      sleepTimerMode === 'end-of-chapter'
                        ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/65'
                        : 'bg-[#0E1116] text-[#E4E9F1] border-[#273040] hover:border-[#22D3EE] hover:text-[#67E8F9]'
                    }`}
                  >
                    Ch. end
                  </button>
                </div>

                {/* Active Timer Controls */}
                {isSleepActive && (
                  <div className="mt-3 pt-2.5 border-t border-[#222833] flex items-center gap-2">
                    {sleepTimerMode === 'countdown' && (
                      <button
                        type="button"
                        onClick={() => onExtendSleepTimer(5)}
                        className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1 font-mono text-xs font-medium text-[#67E8F9] bg-[#101B24] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded transition-colors cursor-pointer"
                      >
                        <Plus className="w-3 h-3" aria-hidden="true" />
                        5 min
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onCancelSleepTimer();
                        setSleepMenuOpen(false);
                      }}
                      className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1 text-xs font-medium text-[#FCA5A5] bg-[#2A1217] border border-[#F87171]/40 hover:border-[#F87171] rounded transition-colors cursor-pointer"
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                      Turn Off
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Commute Mode Trigger */}
          <button
            type="button"
            onClick={onOpenCommuteMode}
            aria-label="Open full-screen Commute Mode"
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#131A22] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded-md whitespace-nowrap transition-colors cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Commute</span>
          </button>
        </div>
      </div>
    </div>
  );
}
