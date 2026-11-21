import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Download,
  Gauge,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import type { AudioBriefing, SharedBriefingManifest } from '../types';
import { fetchSharedBriefing } from '../services/api';
import {
  fetchPublicShareFromFirestore,
  firestoreDocToSharedBriefingManifest,
} from '../services/firestorePublicShares';
import { formatClock } from '../utils/wavUtils';
import { TopicDistributionBar } from './TopicDistributionBar';

interface SharedBriefingViewProps {
  shareId: string;
  onExitSharedView: () => void;
}

const SHARED_PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.85];

function formatTimeRemaining(expiresAt: string): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'Expired';
  const totalHours = Math.floor(diffMs / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) {
    return `${days}d ${hours}h left`;
  }
  const mins = Math.max(1, Math.floor((diffMs % 3600000) / 60000));
  return hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
}

export function SharedBriefingView({
  shareId,
  onExitSharedView,
}: SharedBriefingViewProps) {
  const [share, setShare] = useState<SharedBriefingManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [copiedLink, setCopiedLink] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    setIsExpired(false);

    fetchSharedBriefing(shareId)
      .then(({ share: manifest }) => {
        if (cancelled) return;
        setShare(manifest);
        const firstAudioIdx = manifest.segments.findIndex((s) => s.hasAudio);
        setActiveSegmentIndex(firstAudioIdx >= 0 ? firstAudioIdx : 0);
      })
      .catch(async (err: Error & { expired?: boolean }) => {
        if (cancelled) return;
        if (!err.expired) {
          const fsDoc = await fetchPublicShareFromFirestore(shareId);
          if (!cancelled && fsDoc && fsDoc.kind === 'briefing') {
            const manifest = firestoreDocToSharedBriefingManifest(fsDoc);
            setShare(manifest);
            const firstAudioIdx = manifest.segments.findIndex((s) => s.hasAudio);
            setActiveSegmentIndex(firstAudioIdx >= 0 ? firstAudioIdx : 0);
            return;
          }
        }
        if (!cancelled) {
          setIsExpired(Boolean(err.expired));
          setErrorMessage(err.message || 'Could not load this shared briefing.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const loadChapter = useCallback(
    (manifest: SharedBriefingManifest, index: number, autoPlay: boolean) => {
      const seg = manifest.segments[index];
      const audioEl = audioRef.current;
      if (!seg?.audioUrl || !audioEl) return;

      setActiveSegmentIndex(index);
      setCurrentTime(0);
      setDuration(seg.audioDurationSeconds || seg.estimatedSeconds || 0);

      audioEl.src = seg.audioUrl;
      audioEl.playbackRate = playbackRate;
      audioEl.load();

      if (autoPlay) {
        audioEl
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
      } else {
        setIsPlaying(false);
      }
    },
    [playbackRate]
  );

  // Sync playback rate onto HTMLAudioElement
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Adapt SharedBriefingManifest into AudioBriefing shape for D3 TopicDistributionBar
  const briefingAdapter: AudioBriefing | null = useMemo(() => {
    if (!share) return null;
    return {
      id: `shared-${share.shareId}`,
      createdAt: share.briefingCreatedAt,
      editionTitle: share.editionTitle,
      editionSubtitle: share.editionSubtitle,
      takeaways: share.takeaways,
      preferences: share.preferences,
      articleTitles: share.articleTitles,
      segments: share.segments.map((s) => ({
        id: s.id,
        title: s.title,
        category: s.category,
        sourceTitles: s.sourceTitles,
        keyPoint: s.keyPoint,
        estimatedSeconds: s.estimatedSeconds,
        audioDurationSeconds: s.audioDurationSeconds,
        lines: s.lines,
        coHostVoiceName: s.coHostVoiceName,
        audioBase64: s.hasAudio ? 'hosted' : undefined,
      })),
    };
  }, [share]);

  const handleTogglePlayPause = useCallback(() => {
    if (!share) return;
    const audioEl = audioRef.current;
    if (!audioEl) return;

    const currentSeg = share.segments[activeSegmentIndex];
    if (!currentSeg?.audioUrl) {
      const firstIdx = share.segments.findIndex((s) => s.hasAudio);
      if (firstIdx >= 0) loadChapter(share, firstIdx, true);
      return;
    }

    if (!audioEl.src) {
      loadChapter(share, activeSegmentIndex, true);
      return;
    }

    if (audioEl.paused) {
      audioEl
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      audioEl.pause();
      setIsPlaying(false);
    }
  }, [share, activeSegmentIndex, loadChapter]);

  const handleSeek = useCallback((nextTime: number) => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    const clamped = Math.max(0, Math.min(nextTime, audioEl.duration || nextTime));
    audioEl.currentTime = clamped;
    setCurrentTime(clamped);
  }, []);

  const handleSkip = useCallback((delta: number) => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    const next = Math.max(0, Math.min((audioEl.currentTime || 0) + delta, audioEl.duration || 0));
    audioEl.currentTime = next;
    setCurrentTime(next);
  }, []);

  const handlePrevChapter = useCallback(() => {
    if (!share) return;
    for (let i = activeSegmentIndex - 1; i >= 0; i--) {
      if (share.segments[i].hasAudio) {
        loadChapter(share, i, isPlaying);
        return;
      }
    }
  }, [share, activeSegmentIndex, isPlaying, loadChapter]);

  const handleNextChapter = useCallback(() => {
    if (!share) return;
    for (let i = activeSegmentIndex + 1; i < share.segments.length; i++) {
      if (share.segments[i].hasAudio) {
        loadChapter(share, i, isPlaying);
        return;
      }
    }
  }, [share, activeSegmentIndex, isPlaying, loadChapter]);

  const handleAudioEnded = useCallback(() => {
    if (!share) {
      setIsPlaying(false);
      return;
    }
    for (let i = activeSegmentIndex + 1; i < share.segments.length; i++) {
      if (share.segments[i].hasAudio) {
        loadChapter(share, i, true);
        return;
      }
    }
    setIsPlaying(false);
    setCurrentTime(0);
  }, [share, activeSegmentIndex, loadChapter]);

  const handleCycleRate = useCallback(() => {
    setPlaybackRate((prev) => {
      const idx = SHARED_PLAYBACK_RATES.indexOf(prev);
      return SHARED_PLAYBACK_RATES[(idx + 1) % SHARED_PLAYBACK_RATES.length];
    });
  }, []);

  const handleCopyShareUrl = useCallback(async () => {
    const url = `${window.location.origin}/share/${shareId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Clipboard blocked
    }
  }, [shareId]);

  const activeSegment = share?.segments[activeSegmentIndex];
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const speedLabel = `${Number.isInteger(playbackRate) ? playbackRate.toFixed(1) : playbackRate}x`;

  return (
    <div
      className={`min-h-screen bg-[#0B0D10] text-[#F5F7FA] ${
        share?.hasAudio ? 'pb-28' : 'pb-12'
      }`}
    >
      {/* Top Bar */}
      <header className="sticky top-0 z-30 h-16 bg-[#0B0D10]/95 backdrop-blur-sm border-b border-[#22D3EE]/30">
        <div className="max-w-[1040px] h-full mx-auto px-5 sm:px-8 flex items-center justify-between gap-6">
          <button
            type="button"
            onClick={onExitSharedView}
            className="font-serif text-xl font-semibold tracking-tight text-[#F5F7FA] hover:text-[#67E8F9] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dispatch
          </button>

          {share && (
            <div className="hidden sm:flex items-center gap-2 text-xs text-[#8C96A8] font-mono tabular-nums">
              <span className="text-[#67E8F9]">Shared Briefing</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-[#6E788A]" aria-hidden="true" />
                {formatTimeRemaining(share.expiresAt)}
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={onExitSharedView}
            className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Open Studio
          </button>
        </div>
      </header>

      <main className="max-w-[1040px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
        {loading && (
          <div className="py-24 text-center space-y-3">
            <Loader2
              className="w-6 h-6 text-[#22D3EE] animate-spin mx-auto"
              aria-hidden="true"
            />
            <p className="text-sm text-[#A0AABB]">Loading shared audio briefing...</p>
          </div>
        )}

        {!loading && errorMessage && (
          <div className="max-w-lg mx-auto my-16 bg-[#13161C] border border-[#22D3EE]/35 rounded-lg p-8 text-center">
            <p className="font-mono text-xs text-[#22D3EE]">
              {isExpired ? 'Link Expired' : 'Briefing Unavailable'}
            </p>
            <h1 className="mt-2 font-serif text-2xl font-medium text-[#F5F7FA]">
              {isExpired
                ? 'This temporary briefing link has expired'
                : 'Shared episode not found'}
            </h1>
            <p className="mt-2.5 text-sm text-[#A0AABB] leading-relaxed">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={onExitSharedView}
              className="mt-6 h-10 px-5 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
            >
              Open Dispatch Studio
            </button>
          </div>
        )}

        {!loading && share && briefingAdapter && (
          <div className="space-y-8">
            {/* Edition Masthead */}
            <section className="pb-7 border-b border-[#22D3EE]/35">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                <span className="font-medium text-[#22D3EE]">
                  {share.preferences.format === 'podcast'
                    ? 'Two-Host Podcast'
                    : 'Solo Anchor'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="capitalize">{share.preferences.tone} tone</span>
                <span aria-hidden="true">·</span>
                <span className="capitalize">
                  {share.preferences.voiceTone || 'professional'} voice
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {formatClock(share.totalDurationSeconds)} runtime
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {formatTimeRemaining(share.expiresAt)}
                </span>
              </div>

              <h1 className="mt-3 font-serif text-3xl sm:text-4xl font-medium text-[#F5F7FA] leading-tight max-w-3xl">
                {share.editionTitle}
              </h1>
              {share.editionSubtitle && (
                <p className="mt-2.5 text-base text-[#A0AABB] leading-relaxed max-w-2xl">
                  {share.editionSubtitle}
                </p>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {share.hasAudio && (
                  <button
                    type="button"
                    onClick={handleTogglePlayPause}
                    className="h-10 px-5 inline-flex items-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="w-4 h-4" aria-hidden="true" />
                        Pause Episode
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4" aria-hidden="true" />
                        Listen Now
                      </>
                    )}
                  </button>
                )}

                {share.downloadUrl && (
                  <a
                    href={share.downloadUrl}
                    download
                    className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Download className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                    Download WAV
                  </a>
                )}

                <button
                  type="button"
                  onClick={handleCopyShareUrl}
                  className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  {copiedLink ? (
                    <>
                      <Check className="w-4 h-4 text-[#34D399]" aria-hidden="true" />
                      Link Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                      Copy Link
                    </>
                  )}
                </button>
              </div>
            </section>

            {/* D3 Topic Distribution Progress Bar */}
            <TopicDistributionBar
              briefing={briefingAdapter}
              activeSegmentIndex={activeSegmentIndex}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onSelectSegment={(segmentIndex, segmentId, hasAudio) => {
                const el = segmentRefs.current[segmentId];
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
                if (hasAudio) {
                  loadChapter(share, segmentIndex, true);
                }
              }}
            />

            {/* Two-Column Folio */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Takeaways Rail */}
              {share.takeaways.length > 0 && (
                <aside className="lg:col-span-4 bg-[#13161C] border border-[#22D3EE]/30 rounded-lg p-6">
                  <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
                    Key Takeaways
                  </h2>
                  <ol className="mt-4 space-y-3.5">
                    {share.takeaways.map((point, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-3 text-sm text-[#D5DCE6] leading-relaxed"
                      >
                        <span className="font-mono text-xs text-[#22D3EE] mt-0.5 tabular-nums shrink-0">
                          {String(idx + 1).padStart(2, '0')}.
                        </span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ol>
                </aside>
              )}

              {/* Chapters */}
              <div
                className={`${
                  share.takeaways.length > 0 ? 'lg:col-span-8' : 'lg:col-span-12'
                } space-y-6`}
              >
                {share.segments.map((seg, idx) => {
                  const isCurrent = idx === activeSegmentIndex;
                  const isCurrentPlaying = isCurrent && isPlaying;
                  const segDur = seg.audioDurationSeconds || seg.estimatedSeconds;

                  return (
                    <article
                      key={seg.id}
                      ref={(el) => {
                        segmentRefs.current[seg.id] = el;
                      }}
                      className={`scroll-mt-24 bg-[#13161C] border rounded-lg p-6 transition-colors ${
                        isCurrent && seg.hasAudio
                          ? 'border-[#22D3EE] cyan-rim-strong'
                          : 'border-[#222833]'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-[#222833]">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                            <span className="font-mono font-medium text-[#22D3EE] tabular-nums">
                              Chapter {String(idx + 1).padStart(2, '0')}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{seg.category}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {formatClock(segDur)}
                            </span>
                          </div>
                          <h3 className="mt-1.5 font-serif text-xl font-medium text-[#F5F7FA] leading-snug">
                            {seg.title}
                          </h3>
                          {seg.sourceTitles.length > 0 && (
                            <p className="mt-1 text-xs text-[#6E788A]">
                              Source: {seg.sourceTitles.join(' · ')}
                            </p>
                          )}
                        </div>

                        {seg.hasAudio && (
                          <button
                            type="button"
                            onClick={() =>
                              isCurrent
                                ? handleTogglePlayPause()
                                : loadChapter(share, idx, true)
                            }
                            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              isCurrentPlaying
                                ? 'bg-[#22D3EE] text-[#071318]'
                                : 'bg-[#18212E] text-[#F5F7FA] border border-[#22D3EE]/40 hover:bg-[#1E2A3B]'
                            }`}
                          >
                            {isCurrentPlaying ? (
                              <>
                                <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                                Pause
                              </>
                            ) : (
                              <>
                                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                                Play
                              </>
                            )}
                          </button>
                        )}
                      </div>

                      <div className="mt-4 space-y-3.5 max-w-prose">
                        {seg.lines.map((line, lineIdx) => (
                          <p
                            key={lineIdx}
                            className="text-[15px] text-[#E4E9F1] leading-[1.75]"
                          >
                            {share.preferences.format === 'podcast' && (
                              <span
                                className={`inline-block font-mono text-xs font-medium mr-2.5 ${
                                  line.speaker === 'Alex'
                                    ? 'text-[#22D3EE]'
                                    : 'text-[#A0AABB]'
                                }`}
                              >
                                {line.speaker}:
                              </span>
                            )}
                            {line.text}
                          </p>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Hidden HTML5 Audio Element */}
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={handleAudioEnded}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      {/* Persistent Shared Audio Player Bar */}
      {share?.hasAudio && activeSegment && (
        <div
          role="region"
          aria-label="Shared briefing audio player"
          className="fixed bottom-0 inset-x-0 z-40 bg-[#0D1015]/95 backdrop-blur-md border-t border-[#22D3EE]/45"
        >
          <div className="max-w-[1040px] mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
            <div className="min-w-0 sm:w-64 shrink-0">
              <p className="font-mono text-[11px] text-[#22D3EE] tabular-nums truncate">
                Chapter {activeSegmentIndex + 1} of {share.segments.length} ·{' '}
                {activeSegment.category}
              </p>
              <p className="text-sm font-medium text-[#F5F7FA] truncate">
                {activeSegment.title}
              </p>
            </div>

            <div className="flex items-center justify-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handlePrevChapter}
                disabled={activeSegmentIndex === 0}
                aria-label="Previous chapter"
                className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-35 rounded-md cursor-pointer"
              >
                <SkipBack className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => handleSkip(-15)}
                aria-label="Rewind 15 seconds"
                className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] rounded-md cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleTogglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="w-10 h-10 inline-flex items-center justify-center bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] rounded-full transition-colors cursor-pointer"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => handleSkip(15)}
                aria-label="Forward 15 seconds"
                className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] rounded-md cursor-pointer"
              >
                <RotateCw className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleNextChapter}
                disabled={activeSegmentIndex >= share.segments.length - 1}
                aria-label="Next chapter"
                className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-35 rounded-md cursor-pointer"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 flex items-center gap-3 min-w-0">
              <span className="font-mono text-xs text-[#A0AABB] tabular-nums w-10 text-right shrink-0">
                {formatClock(currentTime)}
              </span>
              <div className="relative flex-1 h-5 flex items-center">
                <div className="w-full h-1.5 bg-[#1D2330] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#22D3EE]"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.25}
                  value={Math.min(currentTime, duration || 1)}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                  aria-label="Seek audio position"
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                />
              </div>
              <span className="font-mono text-xs text-[#6E788A] tabular-nums w-10 shrink-0">
                {formatClock(duration)}
              </span>
            </div>

            <button
              type="button"
              onClick={handleCycleRate}
              aria-label={`Change playback speed, currently ${speedLabel}`}
              className="h-8 px-2.5 inline-flex items-center gap-1.5 font-mono text-xs text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
            >
              <Gauge className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              <span>{speedLabel}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
