import {
  Moon,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import type { AudioBriefing } from '../types';
import { formatClock } from '../utils/wavUtils';
import { formatSleepCountdown, type SleepTimerMode } from './AudioPlayerBar';

interface CommuteModeOverlayProps {
  briefing: AudioBriefing;
  activeSegmentIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  sleepTimerMode: SleepTimerMode;
  sleepTimerRemainingSec: number | null;
  onCycleSleepTimer: () => void;
  onClose: () => void;
  onTogglePlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipSeconds: (delta: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onSelectChapter: (index: number) => void;
  onCyclePlaybackRate: () => void;
}

export function CommuteModeOverlay({
  briefing,
  activeSegmentIndex,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  sleepTimerMode,
  sleepTimerRemainingSec,
  onCycleSleepTimer,
  onClose,
  onTogglePlayPause,
  onSeek,
  onSkipSeconds,
  onPrevChapter,
  onNextChapter,
  onSelectChapter,
  onCyclePlaybackRate,
}: CommuteModeOverlayProps) {
  const segment = briefing.segments[activeSegmentIndex];
  if (!segment) return null;

  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Commute Mode audio player"
      className="fixed inset-0 z-50 bg-[#0B0D10] text-[#F5F7FA] flex flex-col justify-between overflow-y-auto"
    >
      {/* Top Bar */}
      <div className="max-w-4xl w-full mx-auto px-6 py-5 flex items-center justify-between gap-4 border-b border-[#22D3EE]/30">
        <div className="min-w-0">
          <p className="font-mono text-xs text-[#A0AABB] tabular-nums truncate">
            Commute Mode · {briefing.editionTitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-11 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <X className="w-4 h-4 text-[#67E8F9]" aria-hidden="true" />
          Exit
        </button>
      </div>

      {/* Main Centered Stage */}
      <div className="max-w-3xl w-full mx-auto px-6 py-8 flex-1 flex flex-col justify-center">
        <p className="font-mono text-xs tracking-wide text-[#22D3EE] tabular-nums">
          Chapter {activeSegmentIndex + 1} of {briefing.segments.length} · {segment.category}
          {briefing.preferences.format === 'podcast'
            ? ` · ${briefing.preferences.voiceName} & ${
                segment.coHostVoiceName || briefing.preferences.coHostVoiceName
              }`
            : ` · ${briefing.preferences.voiceName}`}
        </p>

        <h1 className="mt-2 font-serif text-3xl sm:text-4xl font-medium text-[#F5F7FA] leading-tight tracking-[0.01em]">
          {segment.title}
        </h1>

        <p className="mt-3 text-base text-[#C4CDD9] leading-relaxed max-w-2xl">
          {segment.keyPoint}
        </p>

        {/* Chapter Switcher Strip */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {briefing.segments.map((seg, idx) => {
            const active = idx === activeSegmentIndex;
            const hasAudio = Boolean(seg.audioBase64);
            return (
              <button
                key={seg.id}
                type="button"
                disabled={!hasAudio}
                onClick={() => onSelectChapter(idx)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md border transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#22D3EE] text-[#071318] border-[#22D3EE] font-semibold'
                    : hasAudio
                      ? 'bg-[#13161C] text-[#E4E9F1] border-[#222833] hover:border-[#22D3EE]/55'
                      : 'bg-[#0E1116] text-[#4C5565] border-[#1A1F28] cursor-not-allowed'
                }`}
              >
                {String(idx + 1).padStart(2, '0')}. {seg.category}
              </button>
            );
          })}
        </div>

        {/* Scrubber */}
        <div className="mt-10 space-y-2.5">
          <input
            type="range"
            aria-label="Seek chapter position"
            min={0}
            max={duration || 100}
            step={0.25}
            value={Math.min(currentTime, duration || 100)}
            onChange={(e) => onSeek(Number(e.target.value))}
            style={{
              background: `linear-gradient(to right, #22D3EE ${progressPercent}%, #232A36 ${progressPercent}%)`,
            }}
            className="dispatch-scrubber dispatch-scrubber-dark w-full h-1.5 rounded-full"
          />
          <div className="flex items-center justify-between font-mono text-xs text-[#A0AABB] tabular-nums">
            <span>{formatClock(currentTime)}</span>
            <span>-{formatClock(Math.max(0, duration - currentTime))}</span>
          </div>
        </div>

        {/* Oversized Commute Transport Controls (>= 52px touch targets) */}
        <div className="mt-8 flex items-center justify-center gap-4 sm:gap-7">
          <button
            type="button"
            onClick={onPrevChapter}
            disabled={activeSegmentIndex === 0}
            aria-label="Previous chapter"
            className="w-13 h-13 rounded-full bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/60 disabled:opacity-25 text-[#F5F7FA] inline-flex items-center justify-center transition-colors cursor-pointer"
          >
            <SkipBack className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => onSkipSeconds(-15)}
            aria-label="Rewind 15 seconds"
            className="w-14 h-14 rounded-full bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/60 text-[#F5F7FA] inline-flex flex-col items-center justify-center transition-colors cursor-pointer"
          >
            <RotateCcw className="w-5 h-5" />
            <span className="font-mono text-[10px] mt-0.5 tabular-nums text-[#A0AABB]">15s</span>
          </button>

          <button
            type="button"
            onClick={onTogglePlayPause}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="w-20 h-20 rounded-full bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] inline-flex items-center justify-center transition-colors shadow-lg cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="w-8 h-8" />
            ) : (
              <Play className="w-8 h-8 ml-1" />
            )}
          </button>

          <button
            type="button"
            onClick={() => onSkipSeconds(15)}
            aria-label="Forward 15 seconds"
            className="w-14 h-14 rounded-full bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/60 text-[#F5F7FA] inline-flex flex-col items-center justify-center transition-colors cursor-pointer"
          >
            <RotateCw className="w-5 h-5" />
            <span className="font-mono text-[10px] mt-0.5 tabular-nums text-[#A0AABB]">15s</span>
          </button>

          <button
            type="button"
            onClick={onNextChapter}
            disabled={activeSegmentIndex >= briefing.segments.length - 1}
            aria-label="Next chapter"
            className="w-13 h-13 rounded-full bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/60 disabled:opacity-25 text-[#F5F7FA] inline-flex items-center justify-center transition-colors cursor-pointer"
          >
            <SkipForward className="w-5 h-5" />
          </button>
        </div>

        {/* Speed & Sleep Timer Controls */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onCyclePlaybackRate}
            className="h-11 px-5 font-mono text-sm font-medium text-[#E4E9F1] bg-[#13161C] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md tabular-nums transition-colors cursor-pointer"
          >
            Playback Speed:{' '}
            <span className="text-[#22D3EE] font-semibold">
              {Number.isInteger(playbackRate) ? `${playbackRate}.0x` : `${playbackRate}x`}
            </span>
          </button>

          <button
            type="button"
            onClick={onCycleSleepTimer}
            className={`h-11 px-5 inline-flex items-center gap-2 font-mono text-sm font-medium rounded-md border tabular-nums transition-colors cursor-pointer ${
              sleepTimerMode !== 'off'
                ? 'bg-[#101B24] border-[#22D3EE]/70 text-[#22D3EE]'
                : 'bg-[#13161C] border-[#273040] hover:border-[#22D3EE]/60 text-[#E4E9F1]'
            }`}
          >
            <Moon className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
            <span>
              Sleep:{' '}
              {sleepTimerMode === 'countdown' && sleepTimerRemainingSec !== null
                ? formatSleepCountdown(sleepTimerRemainingSec)
                : sleepTimerMode === 'end-of-chapter'
                  ? 'Ch. end'
                  : 'Off'}
            </span>
          </button>
        </div>
      </div>

      {/* Live Transcript Footer Snippet */}
      <div className="max-w-3xl w-full mx-auto px-6 py-5 border-t border-[#222833]">
        <p className="font-mono text-[11px] text-[#6E788A] mb-1.5">Current Chapter Script</p>
        <div className="max-h-28 overflow-y-auto space-y-2 text-sm text-[#C4CDD9] leading-relaxed pr-2">
          {segment.lines.map((line, idx) => (
            <p key={idx}>
              {briefing.preferences.format === 'podcast' && (
                <span className="font-mono text-xs text-[#67E8F9] mr-2">
                  {line.speaker}:
                </span>
              )}
              {line.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
