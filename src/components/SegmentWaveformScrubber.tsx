import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  decodeAudioBase64WaveformPeaks,
  extractWavWaveformPeaks,
  formatClock,
} from '../utils/wavUtils';

interface SegmentWaveformScrubberProps {
  segmentId: string;
  audioBase64?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
}

const CANONICAL_BUCKETS = 160;
const CANVAS_HEIGHT = 28;
const BAR_WIDTH = 2;
const BAR_GAP = 2;

function resamplePeaks(source: Float32Array, targetCount: number): Float32Array {
  const out = new Float32Array(targetCount);
  if (targetCount <= 0 || source.length === 0) return out;
  const ratio = source.length / targetCount;

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(source.length, Math.max(start + 1, Math.ceil((i + 1) * ratio)));
    let maxVal = 0;
    let sumVal = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const v = source[j];
      if (v > maxVal) maxVal = v;
      sumVal += v;
      count++;
    }
    const avg = count > 0 ? sumVal / count : 0;
    out[i] = avg * 0.55 + maxVal * 0.45;
  }

  return out;
}

export function SegmentWaveformScrubber({
  segmentId,
  audioBase64,
  currentTime,
  duration,
  isPlaying,
  onSeek,
}: SegmentWaveformScrubberProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const [containerWidth, setContainerWidth] = useState(0);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [asyncPeaks, setAsyncPeaks] = useState<{
    key: string;
    peaks: Float32Array | null;
  }>({ key: '', peaks: null });

  const syncPeaks = useMemo(
    () => extractWavWaveformPeaks(audioBase64, CANONICAL_BUCKETS),
    [audioBase64]
  );

  // Non-WAV base64 fallback (e.g., if a clip is ever encoded as MP3/WebM)
  const fallbackKey = `${segmentId}:${audioBase64 ? audioBase64.length : 0}`;
  useEffect(() => {
    if (syncPeaks || !audioBase64 || audioBase64 === 'hosted' || audioBase64.length < 64) {
      return;
    }
    let cancelled = false;
    decodeAudioBase64WaveformPeaks(audioBase64, CANONICAL_BUCKETS).then((decoded) => {
      if (!cancelled) {
        setAsyncPeaks({ key: fallbackKey, peaks: decoded });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [syncPeaks, audioBase64, fallbackKey]);

  const activePeaks =
    syncPeaks ?? (asyncPeaks.key === fallbackKey ? asyncPeaks.peaks : null);

  // Reset transient hover/drag state when switching chapters
  useEffect(() => {
    setHoverRatio(null);
    setDragRatio(null);
  }, [segmentId]);

  // Track responsive container width via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      setContainerWidth((prev) => (prev === next ? prev : next));
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const barCount = useMemo(() => {
    if (containerWidth <= 0) return 0;
    return Math.max(12, Math.floor((containerWidth + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
  }, [containerWidth]);

  const resampledBars = useMemo(() => {
    if (!activePeaks || barCount <= 0) return null;
    return resamplePeaks(activePeaks, barCount);
  }, [activePeaks, barCount]);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const playRatio =
    dragRatio !== null
      ? dragRatio
      : safeDuration > 0
        ? Math.max(0, Math.min(1, currentTime / safeDuration))
        : 0;

  const activePreviewRatio = dragRatio ?? hoverRatio;
  const previewTime =
    activePreviewRatio !== null && safeDuration > 0
      ? activePreviewRatio * safeDuration
      : null;

  // Imperatively position floating hover timestamp using compositor-only transform
  useEffect(() => {
    const tooltipEl = tooltipRef.current;
    if (!tooltipEl || activePreviewRatio === null || containerWidth <= 0) return;

    const rawX = activePreviewRatio * containerWidth;
    const tooltipW = tooltipEl.offsetWidth || 44;
    const halfW = tooltipW / 2;
    const clampedX = Math.max(halfW, Math.min(containerWidth - halfW, rawX));
    tooltipEl.style.transform = `translate3d(${Math.round(clampedX - halfW)}px, 0, 0)`;
  }, [activePreviewRatio, containerWidth, previewTime]);

  // Paint DPR-sharp mirrored editorial waveform canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerWidth <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(containerWidth * dpr);
    const targetH = Math.round(CANVAS_HEIGHT * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, CANVAS_HEIGHT);

    const centerY = CANVAS_HEIGHT / 2;
    const playX = playRatio * containerWidth;
    const previewX = hoverRatio !== null ? hoverRatio * containerWidth : null;

    // Subtle 1px center baseline so silent pauses remain readable and clickable
    ctx.fillStyle = 'rgba(160, 170, 187, 0.16)';
    ctx.fillRect(0, centerY - 0.5, containerWidth, 1);

    if (resampledBars && resampledBars.length > 0) {
      const count = resampledBars.length;
      const totalContentW = count * BAR_WIDTH + (count - 1) * BAR_GAP;
      const startOffsetX = Math.max(0, (containerWidth - totalContentW) / 2);
      const maxBarH = CANVAS_HEIGHT - 4;
      const minBarH = 3;

      for (let i = 0; i < count; i++) {
        const amp = resampledBars[i];
        const barH = Math.max(minBarH, Math.min(maxBarH, minBarH + amp * (maxBarH - minBarH)));
        const x = startOffsetX + i * (BAR_WIDTH + BAR_GAP);
        const barMidX = x + BAR_WIDTH / 2;
        const y = centerY - barH / 2;

        const isPlayed = barMidX <= playX;
        const isAtPlayhead = Math.abs(barMidX - playX) <= BAR_WIDTH + 1;

        let fillStyle: string;
        if (previewX !== null && dragRatio === null) {
          if (previewX >= playX) {
            // Hovering ahead of playhead
            if (isPlayed) {
              fillStyle = isAtPlayhead
                ? '#67E8F9'
                : amp > 0.72
                  ? '#38DCF2'
                  : '#22D3EE';
            } else if (barMidX <= previewX) {
              fillStyle = '#476178';
            } else {
              fillStyle = '#2B3444';
            }
          } else {
            // Hovering behind playhead (rewind target)
            if (barMidX <= previewX) {
              fillStyle = amp > 0.72 ? '#38DCF2' : '#22D3EE';
            } else if (isPlayed) {
              fillStyle = 'rgba(34, 211, 238, 0.45)';
            } else {
              fillStyle = '#2B3444';
            }
          }
        } else if (isPlayed) {
          fillStyle = isAtPlayhead && (isPlaying || dragRatio !== null)
            ? '#67E8F9'
            : amp > 0.74
              ? '#38DCF2'
              : '#22D3EE';
        } else {
          fillStyle = '#2B3444';
        }

        ctx.fillStyle = fillStyle;
        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, barH, 1);
        ctx.fill();
      }
    } else {
      // Graceful flat editorial track fallback when audioBase64 is unavailable or hosted-only
      const trackH = 3;
      const trackY = centerY - trackH / 2;
      ctx.fillStyle = '#232A36';
      ctx.beginPath();
      ctx.roundRect(0, trackY, containerWidth, trackH, 1.5);
      ctx.fill();

      if (previewX !== null && previewX > playX && dragRatio === null) {
        ctx.fillStyle = '#476178';
        ctx.beginPath();
        ctx.roundRect(playX, trackY, previewX - playX, trackH, 1.5);
        ctx.fill();
      }

      if (playX > 0) {
        ctx.fillStyle = '#22D3EE';
        ctx.beginPath();
        ctx.roundRect(0, trackY, playX, trackH, 1.5);
        ctx.fill();
      }
    }

    // Subtle hairline hover cursor when hovering
    if (previewX !== null && dragRatio === null && safeDuration > 0) {
      const clampedHoverX = Math.max(0.5, Math.min(containerWidth - 0.5, previewX));
      ctx.fillStyle = 'rgba(245, 247, 250, 0.55)';
      ctx.fillRect(clampedHoverX - 0.5, 2, 1, CANVAS_HEIGHT - 4);
    }

    // Crisp vertical playhead
    if (safeDuration > 0) {
      const clampedPlayX = Math.max(1, Math.min(containerWidth - 1, playX));
      ctx.fillStyle = '#67E8F9';
      ctx.beginPath();
      ctx.roundRect(clampedPlayX - 0.75, 1, 1.5, CANVAS_HEIGHT - 2, 0.75);
      ctx.fill();
    }

    ctx.restore();
  }, [
    containerWidth,
    resampledBars,
    playRatio,
    hoverRatio,
    dragRatio,
    isPlaying,
    safeDuration,
  ]);

  const computeRatioFromClientX = useCallback((clientX: number): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || safeDuration <= 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const ratio = computeRatioFromClientX(e.clientX);
      setDragRatio(ratio);
      setHoverRatio(ratio);
      onSeek(ratio * safeDuration);
    },
    [computeRatioFromClientX, onSeek, safeDuration]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (safeDuration <= 0) return;
      const ratio = computeRatioFromClientX(e.clientX);
      setHoverRatio(ratio);
      if (dragRatio !== null) {
        setDragRatio(ratio);
        onSeek(ratio * safeDuration);
      }
    },
    [computeRatioFromClientX, dragRatio, onSeek, safeDuration]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (dragRatio === null) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const ratio = computeRatioFromClientX(e.clientX);
      setDragRatio(null);
      if (safeDuration > 0) {
        onSeek(ratio * safeDuration);
      }
    },
    [computeRatioFromClientX, dragRatio, onSeek, safeDuration]
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setDragRatio(null);
    },
    []
  );

  const handlePointerLeave = useCallback(() => {
    if (dragRatio === null) {
      setHoverRatio(null);
    }
  }, [dragRatio]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (safeDuration <= 0) return;
      let nextTime: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        nextTime = Math.min(safeDuration, currentTime + 5);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        nextTime = Math.max(0, currentTime - 5);
      } else if (e.key === 'PageUp') {
        nextTime = Math.min(safeDuration, currentTime + 15);
      } else if (e.key === 'PageDown') {
        nextTime = Math.max(0, currentTime - 15);
      } else if (e.key === 'Home') {
        nextTime = 0;
      } else if (e.key === 'End') {
        nextTime = safeDuration;
      }

      if (nextTime !== null) {
        e.preventDefault();
        onSeek(nextTime);
      }
    },
    [currentTime, onSeek, safeDuration]
  );

  const effectiveTime =
    dragRatio !== null && safeDuration > 0 ? dragRatio * safeDuration : currentTime;

  return (
    <div
      ref={containerRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek audio position along segment waveform"
      aria-valuemin={0}
      aria-valuemax={Math.round(safeDuration)}
      aria-valuenow={Math.round(effectiveTime)}
      aria-valuetext={`${formatClock(effectiveTime)} of ${formatClock(safeDuration)}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      className="relative flex-1 h-7 flex items-center select-none touch-none cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22D3EE]"
    >
      {/* Floating Hover / Scrub Timestamp */}
      {previewTime !== null && (
        <div
          ref={tooltipRef}
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-0 mb-1.5 z-50 px-1.5 py-0.5 rounded bg-[#0E1116] border border-[#273040] font-mono text-[11px] font-medium text-[#F5F7FA] tabular-nums shadow-lg whitespace-nowrap"
        >
          {formatClock(previewTime)}
        </div>
      )}

      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="w-full h-7 block"
      />
    </div>
  );
}
