import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Headphones,
  ListChecks,
  Loader2,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import {
  VOICE_OPTIONS,
  type AudioBriefing,
  type BriefingSegment,
  type CitationRef,
  type NewsArticle,
  type ScriptLine,
  type VoiceName,
} from '../types';
import { formatClock } from '../utils/wavUtils';
import { CitationList, CitedText, HighlightText } from './CitedText';
import { TakeawaySnapshotModal } from './TakeawaySnapshotModal';
import { ShareBriefingModal } from './ShareBriefingModal';
import { TopicDistributionBar } from './TopicDistributionBar';
import { BriefingBreakdownPanel } from './BriefingBreakdownPanel';

interface BriefingStudioViewProps {
  briefing: AudioBriefing | null;
  sources?: NewsArticle[];
  activeSegmentIndex: number;
  currentTime: number;
  isPlaying: boolean;
  synthesizingSegmentId: string | null;
  isSynthesizingAll: boolean;
  isRefining: boolean;
  refineError: string | null;
  ttsError: string | null;
  onGoToArticles: () => void;
  onPlaySegment: (index: number) => void;
  onTogglePlayPause: () => void;
  onRestartBriefing: () => void;
  onSynthesizeSegment: (segmentId: string) => Promise<void>;
  onSynthesizeAll: () => Promise<void>;
  onUpdateSegmentLines: (segmentId: string, lines: ScriptLine[]) => void;
  onUpdateSegmentCoHostVoice: (segmentId: string, voice: VoiceName) => void;
  onRefineScript: (instruction: string, targetSegmentId?: string) => Promise<void>;
  onSelectCitation: (citation: CitationRef) => void;
  onDownloadFullWav: () => void;
  onOpenCommuteMode: () => void;
  onPreviewShare: (shareId: string) => void;
  onProjectBriefingTo3D?: (briefing: AudioBriefing) => void;
  onOpenDriveExport?: () => void;
  onSendTakeawaysToTasks?: (indices?: number[]) => void;
}

const REFINE_PRESETS = [
  'Tighten pacing and cut filler by 20%',
  'Explain technical terms in plain English',
  'Make transitions between stories smoother',
];

export function BriefingStudioView({
  briefing,
  sources,
  activeSegmentIndex,
  currentTime,
  isPlaying,
  synthesizingSegmentId,
  isSynthesizingAll,
  isRefining,
  refineError,
  ttsError,
  onGoToArticles,
  onPlaySegment,
  onTogglePlayPause,
  onRestartBriefing,
  onSynthesizeSegment,
  onSynthesizeAll,
  onUpdateSegmentLines,
  onUpdateSegmentCoHostVoice,
  onRefineScript,
  onSelectCitation,
  onDownloadFullWav,
  onOpenCommuteMode,
  onPreviewShare,
  onProjectBriefingTo3D,
  onOpenDriveExport,
  onSendTakeawaysToTasks,
}: BriefingStudioViewProps) {
  const [refinePrompt, setRefinePrompt] = useState('');
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [draftLines, setDraftLines] = useState<ScriptLine[]>([]);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  // Full-text transcript search state
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyMatchingChapters, setOnlyMatchingChapters] = useState(false);
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const segmentRefs = useRef<Record<string, HTMLElement | null>>({});

  const normalizedQuery = searchQuery.trim();

  // Compute match entries across all transcript lines (and chapter match counts)
  const searchSummary = useMemo(() => {
    const empty = {
      lineMatches: [] as Array<{
        key: string;
        segmentId: string;
        lineIdx: number;
        occurrences: number;
      }>,
      segmentCounts: {} as Record<string, number>,
      totalOccurrences: 0,
      matchingChapters: 0,
    };

    if (!briefing || !normalizedQuery) return empty;

    const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const lineMatches: Array<{
      key: string;
      segmentId: string;
      lineIdx: number;
      occurrences: number;
    }> = [];
    const segmentCounts: Record<string, number> = {};
    let totalOccurrences = 0;

    for (const seg of briefing.segments) {
      let segCount = 0;
      seg.lines.forEach((line, lineIdx) => {
        const textMatches = line.text.match(regex)?.length ?? 0;
        const speakerMatches =
          briefing.preferences.format === 'podcast'
            ? line.speaker.match(regex)?.length ?? 0
            : 0;
        const count = textMatches + speakerMatches;
        if (count > 0) {
          lineMatches.push({
            key: `${seg.id}-${lineIdx}`,
            segmentId: seg.id,
            lineIdx,
            occurrences: count,
          });
          segCount += count;
          totalOccurrences += count;
        }
      });

      const titleMatches = seg.title.match(regex)?.length ?? 0;
      if (segCount > 0 || titleMatches > 0) {
        segmentCounts[seg.id] = segCount + titleMatches;
      }
    }

    return {
      lineMatches,
      segmentCounts,
      totalOccurrences,
      matchingChapters: Object.keys(segmentCounts).length,
    };
  }, [briefing, normalizedQuery]);

  // Reset search cursor when query or briefing changes
  useEffect(() => {
    setActiveMatchCursor(0);
  }, [normalizedQuery, briefing?.id]);

  // Scroll smoothly to the focused matching line when stepping through matches
  const activeMatchEntry =
    normalizedQuery && searchSummary.lineMatches.length > 0
      ? searchSummary.lineMatches[
          activeMatchCursor % searchSummary.lineMatches.length
        ]
      : null;

  function stepSearchMatch(delta: number) {
    const total = searchSummary.lineMatches.length;
    if (total === 0) return;
    const nextIdx = (activeMatchCursor + delta + total) % total;
    setActiveMatchCursor(nextIdx);
    const target = searchSummary.lineMatches[nextIdx];
    const el = target ? lineRefs.current[target.key] : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  if (!briefing) {
    return (
      <div className="max-w-[820px] mx-auto px-5 sm:px-8 py-20 text-center">
        <p className="font-mono text-xs text-[#22D3EE]">No Active Edition</p>
        <h1 className="mt-2 font-serif text-3xl font-medium text-[#F5F7FA]">
          Build your commute briefing from the Studio desk
        </h1>
        <p className="mt-3 text-sm text-[#A0AABB] max-w-md mx-auto leading-relaxed">
          Check the documents and news sources you want in the Sources sidebar, configure your commute length and voices, and Dispatch will write and record a cited audio episode.
        </p>
        <button
          type="button"
          onClick={onGoToArticles}
          className="mt-6 px-5 py-2.5 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
        >
          Go to Studio
        </button>
      </div>
    );
  }

  const readyAudioCount = briefing.segments.filter((s) => Boolean(s.audioBase64)).length;
  const allAudioReady = readyAudioCount === briefing.segments.length && briefing.segments.length > 0;
  const hasStaleOrMissing = briefing.segments.some((s) => !s.audioBase64 || s.audioStale);
  const totalSeconds = briefing.segments.reduce(
    (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
    0
  );

  function startEditing(segment: BriefingSegment) {
    setEditingSegmentId(segment.id);
    setDraftLines(segment.lines.map((l) => ({ ...l })));
  }

  function cancelEditing() {
    setEditingSegmentId(null);
    setDraftLines([]);
  }

  async function saveEdits(segmentId: string, reRecord: boolean) {
    const cleaned = draftLines.filter((l) => l.text.trim().length > 0);
    if (cleaned.length === 0) return;
    onUpdateSegmentLines(segmentId, cleaned);
    setEditingSegmentId(null);
    if (reRecord) {
      await onSynthesizeSegment(segmentId);
    }
  }

  async function handleRefineSubmit(e: FormEvent) {
    e.preventDefault();
    if (!refinePrompt.trim()) return;
    const prompt = refinePrompt.trim();
    setRefinePrompt('');
    await onRefineScript(prompt);
  }

  return (
    <div className="max-w-[1100px] mx-auto px-5 sm:px-8 py-8 sm:py-9 space-y-9">
      {/* Edition Masthead */}
      <section className="pb-7 border-b border-[#22D3EE]/35">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
          <span className="font-medium text-[#22D3EE]">
            {briefing.preferences.format === 'podcast' ? 'Two-Host Podcast' : 'Solo Anchor'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">{briefing.preferences.tone} tone</span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">
            {briefing.preferences.voiceTone || 'professional'} voice
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {briefing.preferences.format === 'podcast'
              ? (() => {
                  const uniquePanelists = Array.from(
                    new Set(
                      briefing.segments.map(
                        (s) => s.coHostVoiceName || briefing.preferences.coHostVoiceName
                      )
                    )
                  );
                  return uniquePanelists.length > 1
                    ? `${briefing.preferences.voiceName} + ${uniquePanelists.length}-voice panel`
                    : `${briefing.preferences.voiceName} & ${uniquePanelists[0] || briefing.preferences.coHostVoiceName}`;
                })()
              : briefing.preferences.voiceName}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">{formatClock(totalSeconds)} runtime</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {readyAudioCount}/{briefing.segments.length} chapters recorded
          </span>
        </div>

        <h1 className="mt-3 font-serif text-3xl sm:text-4xl font-medium text-[#F5F7FA] leading-tight max-w-3xl">
          {briefing.editionTitle}
        </h1>
        <p className="mt-2.5 text-base text-[#A0AABB] leading-relaxed max-w-2xl">
          {briefing.editionSubtitle}
        </p>

        {/* Action Strip */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {readyAudioCount > 0 ? (
            <>
              <button
                type="button"
                onClick={onTogglePlayPause}
                className="h-10 px-5 inline-flex items-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-4 h-4" aria-hidden="true" />
                    Pause Briefing
                  </>
                ) : activeSegmentIndex > 0 || currentTime >= 2 ? (
                  <>
                    <Play className="w-4 h-4" aria-hidden="true" />
                    Resume Ch. {activeSegmentIndex + 1} · {formatClock(currentTime)}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" aria-hidden="true" />
                    Listen Now
                  </>
                )}
              </button>

              {(activeSegmentIndex > 0 || currentTime >= 2) && (
                <button
                  type="button"
                  onClick={onRestartBriefing}
                  className="h-10 px-3.5 inline-flex items-center gap-1.5 text-sm font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Start Over
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={isSynthesizingAll || Boolean(synthesizingSegmentId)}
              onClick={onSynthesizeAll}
              className="h-10 px-5 inline-flex items-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              {isSynthesizingAll ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  Recording chapters...
                </>
              ) : (
                <>
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  Record All Chapters
                </>
              )}
            </button>
          )}

          {readyAudioCount > 0 && hasStaleOrMissing && (
            <button
              type="button"
              disabled={isSynthesizingAll || Boolean(synthesizingSegmentId)}
              onClick={onSynthesizeAll}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              {isSynthesizingAll ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  Updating audio...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                  Record Remaining
                </>
              )}
            </button>
          )}

          {readyAudioCount > 0 && (
            <button
              type="button"
              onClick={onOpenCommuteMode}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Maximize2 className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Commute Mode
            </button>
          )}

          {allAudioReady && (
            <button
              type="button"
              onClick={onDownloadFullWav}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Download WAV
            </button>
          )}

          <button
            type="button"
            onClick={() => setShareModalOpen(true)}
            className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/55 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap cursor-pointer"
          >
            <Globe className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
            Share
          </button>

          {briefing.takeaways.length > 0 && (
            <button
              type="button"
              onClick={() => setSnapshotOpen(true)}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Share2 className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Snapshot Card
            </button>
          )}

          {onOpenDriveExport && (
            <button
              type="button"
              onClick={onOpenDriveExport}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <HardDrive className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Google Docs &amp; Drive
            </button>
          )}

          {onSendTakeawaysToTasks && briefing.takeaways.length > 0 && (
            <button
              type="button"
              onClick={() => onSendTakeawaysToTasks()}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ListChecks className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Google Tasks
            </button>
          )}

          {onProjectBriefingTo3D && (
            <button
              type="button"
              onClick={() => onProjectBriefingTo3D(briefing)}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#67E8F9] bg-[#13161C] border border-[#22D3EE]/50 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Box className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              3D Foil Stage
            </button>
          )}
        </div>

        {(briefing.exportedDocUrl ||
          briefing.exportedWavUrl ||
          (briefing.syncedTaskCount && briefing.syncedTaskCount > 0)) && (
          <div className="mt-3.5 flex flex-wrap items-center gap-2.5 text-xs text-[#8C96A8] tabular-nums">
            {briefing.exportedDocUrl && (
              <a
                href={briefing.exportedDocUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[#67E8F9] hover:underline whitespace-nowrap"
              >
                Open Google Doc
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
            {briefing.exportedDocUrl && briefing.exportedWavUrl && (
              <span aria-hidden="true">·</span>
            )}
            {briefing.exportedWavUrl && (
              <a
                href={briefing.exportedWavUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[#67E8F9] hover:underline whitespace-nowrap"
              >
                Open WAV in Drive
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
            {(briefing.exportedDocUrl || briefing.exportedWavUrl) &&
              Boolean(briefing.syncedTaskCount && briefing.syncedTaskCount > 0) && (
                <span aria-hidden="true">·</span>
              )}
            {Boolean(briefing.syncedTaskCount && briefing.syncedTaskCount > 0) && (
              <span className="font-mono text-[#A0AABB]">
                {briefing.syncedTaskCount}{' '}
                {briefing.syncedTaskCount === 1 ? 'task' : 'tasks'} synced
              </span>
            )}
          </div>
        )}

        {ttsError && (
          <p
            role="alert"
            className="mt-4 text-sm text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-4 py-2.5"
          >
            {ttsError}
          </p>
        )}
      </section>

      {/* D3 Topic Distribution & Duration Progress Bar */}
      <TopicDistributionBar
        briefing={briefing}
        sources={sources}
        activeSegmentIndex={activeSegmentIndex}
        currentTime={currentTime}
        isPlaying={isPlaying}
        onSelectSegment={(segmentIndex, segmentId, hasAudio) => {
          const el = segmentRefs.current[segmentId];
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          if (hasAudio) {
            onPlaySegment(segmentIndex);
          }
        }}
      />

      {/* Recharts Editorial Content Breakdown (Topic Coverage · Source Mix · Tone & Sentiment) */}
      <BriefingBreakdownPanel
        briefing={briefing}
        sources={sources}
        onSelectChapterByIndex={(segmentIndex, segmentId) => {
          const el = segmentRefs.current[segmentId];
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          if (briefing.segments[segmentIndex]?.audioBase64) {
            onPlaySegment(segmentIndex);
          }
        }}
      />

      {/* Two-Column Folio: Left Key Takeaways + Script Refiner, Right Chapters */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        {/* Left Margin Rail (4 cols) */}
        <aside className="xl:col-span-4 space-y-6">
          {/* Executive Takeaways with Clickable Citations */}
          <section className="bg-[#13161C] border border-[#22D3EE]/30 rounded-lg p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
                Key Takeaways
              </h2>
              {briefing.takeaways.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {onSendTakeawaysToTasks && (
                    <button
                      type="button"
                      onClick={() => onSendTakeawaysToTasks()}
                      className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#E4E9F1] hover:text-[#67E8F9] bg-[#0E1116] border border-[#273040] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <ListChecks className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                      Send to Tasks
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSnapshotOpen(true)}
                    className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#0E1116] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Share Card
                  </button>
                </div>
              )}
            </div>
            <ol className="mt-4 space-y-3.5">
              {briefing.takeaways.map((point, idx) => (
                <li
                  key={idx}
                  className="group flex items-start justify-between gap-3 text-sm text-[#D5DCE6] leading-relaxed"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span className="font-mono text-xs text-[#22D3EE] mt-0.5 tabular-nums shrink-0">
                      {String(idx + 1).padStart(2, '0')}.
                    </span>
                    <span className="min-w-0">
                      <CitedText
                        text={point}
                        citations={briefing.takeawayCitations}
                        onSelectCitation={onSelectCitation}
                        highlightQuery={normalizedQuery}
                      />
                    </span>
                  </div>
                  {onSendTakeawaysToTasks && (
                    <button
                      type="button"
                      onClick={() => onSendTakeawaysToTasks([idx])}
                      title="Add this takeaway to Google Tasks"
                      className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#8C96A8] hover:text-[#67E8F9] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                    >
                      <Plus className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                      Add task
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <CitationList
              citations={briefing.takeawayCitations}
              onSelectCitation={onSelectCitation}
            />
          </section>

          {/* Editorial AI Script Refiner */}
          <section className="bg-[#13161C] border border-[#222833] rounded-lg p-6">
            <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
              Refine Script
            </h2>
            <p className="mt-1 text-xs text-[#8C96A8] leading-relaxed">
              Give an editorial note to revise tone, clarity, or pacing before recording.
            </p>

            <form onSubmit={handleRefineSubmit} className="mt-4 space-y-3">
              <label htmlFor="refine-script-input" className="sr-only">
                Editorial revision note
              </label>
              <textarea
                id="refine-script-input"
                rows={3}
                value={refinePrompt}
                onChange={(e) => setRefinePrompt(e.target.value)}
                placeholder="e.g., Make the opening punchier and connect the uploaded report to the news."
                disabled={isRefining}
                className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
              />
              <button
                type="submit"
                disabled={isRefining || !refinePrompt.trim()}
                className="w-full h-10 px-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#18212E] hover:bg-[#1E2A3B] border border-[#22D3EE]/45 disabled:opacity-45 rounded-md transition-colors cursor-pointer"
              >
                {isRefining ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" aria-hidden="true" />
                    Revising script...
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                    Apply Revision
                  </>
                )}
              </button>
            </form>

            <div className="mt-4 pt-4 border-t border-[#222833] space-y-1.5">
              <p className="text-xs text-[#6E788A]">Quick notes</p>
              {REFINE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isRefining}
                  onClick={() => onRefineScript(preset)}
                  className="block w-full text-left text-xs text-[#A0AABB] hover:text-[#67E8F9] py-1 transition-colors cursor-pointer"
                >
                  {preset}
                </button>
              ))}
            </div>

            {refineError && (
              <p
                role="alert"
                className="mt-3 text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2"
              >
                {refineError}
              </p>
            )}
          </section>
        </aside>

        {/* Right Broadcast Chapters Folio (8 cols) */}
        <div className="xl:col-span-8 space-y-6">
          {/* Full-Text Transcript Search Bar */}
          <section
            aria-label="Search briefing transcript"
            className={`bg-[#13161C] border rounded-lg p-3.5 transition-colors ${
              normalizedQuery
                ? 'border-[#22D3EE]/55'
                : 'border-[#222833] focus-within:border-[#22D3EE]/50'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
              <div className="relative flex-1 min-w-0">
                <Search
                  className="w-4 h-4 text-[#22D3EE] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <label htmlFor="transcript-search-input" className="sr-only">
                  Search briefing transcript
                </label>
                <input
                  id="transcript-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      stepSearchMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === 'Escape') {
                      setSearchQuery('');
                      setOnlyMatchingChapters(false);
                    }
                  }}
                  placeholder="Search transcript lines, topics, or speakers..."
                  className="w-full h-9 pl-9 pr-8 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setOnlyMatchingChapters(false);
                    }}
                    aria-label="Clear transcript search"
                    className="w-7 h-7 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#F5F7FA] absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {normalizedQuery && (
                <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2 shrink-0">
                  <span
                    role="status"
                    className="font-mono text-xs tabular-nums text-[#A0AABB] whitespace-nowrap"
                  >
                    {searchSummary.lineMatches.length > 0 ? (
                      <>
                        <span className="text-[#67E8F9] font-medium">
                          {(activeMatchCursor % searchSummary.lineMatches.length) + 1}
                        </span>
                        /{searchSummary.lineMatches.length} lines ·{' '}
                        {searchSummary.totalOccurrences}{' '}
                        {searchSummary.totalOccurrences === 1 ? 'hit' : 'hits'}
                      </>
                    ) : (
                      <span className="text-[#F87171]">No matches</span>
                    )}
                  </span>

                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      disabled={searchSummary.lineMatches.length === 0}
                      onClick={() => stepSearchMatch(-1)}
                      aria-label="Previous matching line"
                      title="Previous match (Shift+Enter)"
                      className="w-8 h-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#273040] hover:border-[#22D3EE]/55 disabled:opacity-35 rounded-md transition-colors cursor-pointer"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={searchSummary.lineMatches.length === 0}
                      onClick={() => stepSearchMatch(1)}
                      aria-label="Next matching line"
                      title="Next match (Enter)"
                      className="w-8 h-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#273040] hover:border-[#22D3EE]/55 disabled:opacity-35 rounded-md transition-colors cursor-pointer"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setOnlyMatchingChapters((v) => !v)}
                    aria-pressed={onlyMatchingChapters}
                    className={`h-8 px-2.5 font-mono text-[11px] rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                      onlyMatchingChapters
                        ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/60'
                        : 'bg-[#0E1116] text-[#8C96A8] border-[#273040] hover:text-[#F5F7FA] hover:border-[#22D3EE]/45'
                    }`}
                  >
                    Matches only
                  </button>
                </div>
              )}
            </div>
          </section>

          {normalizedQuery &&
            onlyMatchingChapters &&
            searchSummary.matchingChapters === 0 && (
              <div className="bg-[#13161C] border border-[#222833] rounded-lg p-10 text-center">
                <p className="font-serif text-lg text-[#F5F7FA]">
                  No transcript lines match &ldquo;{normalizedQuery}&rdquo;
                </p>
                <p className="mt-1 text-xs text-[#8C96A8]">
                  Try a broader topic keyword or clear the search filter to view all chapters.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setOnlyMatchingChapters(false);
                  }}
                  className="mt-4 h-9 px-4 text-xs font-medium text-[#67E8F9] bg-[#0E1116] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded-md transition-colors cursor-pointer"
                >
                  Clear Search
                </button>
              </div>
            )}

          {briefing.segments.map((segment, index) => {
            const segmentMatchCount = searchSummary.segmentCounts[segment.id] ?? 0;
            if (normalizedQuery && onlyMatchingChapters && segmentMatchCount === 0) {
              return null;
            }

            const isCurrent = index === activeSegmentIndex;
            const isCurrentPlaying = isCurrent && isPlaying;
            const isSynthesizingThis = synthesizingSegmentId === segment.id;
            const isEditingThis = editingSegmentId === segment.id;
            const durationSec = segment.audioDurationSeconds || segment.estimatedSeconds;

            return (
              <article
                key={segment.id}
                ref={(el) => {
                  segmentRefs.current[segment.id] = el;
                }}
                className={`scroll-mt-24 bg-[#13161C] border rounded-lg p-6 transition-colors ${
                  isCurrent && segment.audioBase64
                    ? 'border-[#22D3EE] cyan-rim-strong'
                    : normalizedQuery && segmentMatchCount > 0
                      ? 'border-[#22D3EE]/50'
                      : 'border-[#222833] hover:border-[#22D3EE]/35'
                }`}
              >
                {/* Chapter Header */}
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-4 border-b border-[#222833]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                      <span className="font-mono font-medium text-[#22D3EE] tabular-nums">
                        Chapter {String(index + 1).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{segment.category}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatClock(durationSec)}
                      </span>
                      {normalizedQuery && segmentMatchCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-[#67E8F9] font-medium tabular-nums">
                            {segmentMatchCount}{' '}
                            {segmentMatchCount === 1 ? 'match' : 'matches'}
                          </span>
                        </>
                      )}
                      {segment.audioStale && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#FBBF24] font-medium">
                            Edited — re-record to update audio
                          </span>
                        </>
                      )}
                    </div>

                    <h3 className="mt-1.5 font-serif text-xl font-medium text-[#F5F7FA] leading-snug">
                      <HighlightText
                        text={segment.title}
                        query={normalizedQuery}
                      />
                    </h3>

                    {segment.sourceTitles.length > 0 && (
                      <p className="mt-1 text-xs text-[#6E788A]">
                        Source: {segment.sourceTitles.join(' · ')}
                      </p>
                    )}
                  </div>

                  {/* Chapter Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {briefing.preferences.format === 'podcast' && (
                      <div className="inline-flex items-center gap-1.5">
                        <label
                          htmlFor={`chapter-cohost-${segment.id}`}
                          className="text-[11px] font-mono text-[#8C96A8] whitespace-nowrap"
                        >
                          Co-host
                        </label>
                        <select
                          id={`chapter-cohost-${segment.id}`}
                          value={
                            segment.coHostVoiceName ||
                            briefing.preferences.coHostVoiceName
                          }
                          disabled={isSynthesizingThis || isSynthesizingAll}
                          onChange={(e) =>
                            onUpdateSegmentCoHostVoice(
                              segment.id,
                              e.target.value as VoiceName
                            )
                          }
                          className="h-9 px-2.5 text-xs font-medium text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md focus:border-[#22D3EE] disabled:opacity-45"
                        >
                          {VOICE_OPTIONS.filter(
                            (v) => v.name !== briefing.preferences.voiceName
                          ).map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {segment.audioBase64 && !segment.audioStale ? (
                      <button
                        type="button"
                        onClick={() =>
                          isCurrent ? onTogglePlayPause() : onPlaySegment(index)
                        }
                        className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
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
                    ) : (
                      <button
                        type="button"
                        disabled={isSynthesizingThis || isSynthesizingAll}
                        onClick={() => onSynthesizeSegment(segment.id)}
                        className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {isSynthesizingThis ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            Recording...
                          </>
                        ) : (
                          <>
                            <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
                            {segment.audioStale ? 'Re-record' : 'Record'}
                          </>
                        )}
                      </button>
                    )}

                    {!isEditingThis && (
                      <button
                        type="button"
                        onClick={() => startEditing(segment)}
                        className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                        Edit
                      </button>
                    )}
                  </div>
                </div>

                {/* Chapter Script Body */}
                {isEditingThis ? (
                  <div className="mt-4 space-y-3">
                    {draftLines.map((line, lineIdx) => (
                      <div key={lineIdx} className="space-y-1">
                        <span className="font-mono text-[11px] font-medium text-[#67E8F9]">
                          {line.speaker}
                        </span>
                        <textarea
                          rows={3}
                          value={line.text}
                          onChange={(e) => {
                            const next = [...draftLines];
                            next[lineIdx] = { ...next[lineIdx], text: e.target.value };
                            setDraftLines(next);
                          }}
                          className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md focus:border-[#22D3EE] leading-relaxed"
                        />
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={cancelEditing}
                        className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] border border-[#2A3342] rounded-md cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdits(segment.id, false)}
                        className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#18212E] hover:bg-[#1E2A3B] border border-[#2A3342] rounded-md cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        Save Script
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdits(segment.id, true)}
                        className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md cursor-pointer"
                      >
                        <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
                        Save &amp; Re-record
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4">
                    <div className="space-y-3.5 max-w-prose">
                      {segment.lines.map((line, lineIdx) => {
                        const lineKey = `${segment.id}-${lineIdx}`;
                        const isFocusedMatch =
                          activeMatchEntry?.key === lineKey;

                        return (
                          <div
                            key={lineIdx}
                            ref={(el) => {
                              lineRefs.current[lineKey] = el;
                            }}
                            className={`text-[15px] text-[#E4E9F1] leading-[1.75] rounded-md transition-colors ${
                              isFocusedMatch
                                ? 'bg-[#12202B]/80 border border-[#22D3EE]/45 px-3 py-2 -mx-3'
                                : ''
                            }`}
                          >
                            {briefing.preferences.format === 'podcast' && (
                              <span
                                className={`inline-block font-mono text-xs font-medium mr-2.5 ${
                                  line.speaker === 'Alex'
                                    ? 'text-[#22D3EE]'
                                    : 'text-[#A0AABB]'
                                }`}
                              >
                                <HighlightText
                                  text={line.speaker}
                                  query={normalizedQuery}
                                  emphasized={isFocusedMatch}
                                />
                                :
                              </span>
                            )}
                            <span>
                              <CitedText
                                text={line.text}
                                citations={segment.citations}
                                onSelectCitation={onSelectCitation}
                                highlightQuery={normalizedQuery}
                                emphasizedMatch={isFocusedMatch}
                              />
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <CitationList
                      citations={segment.citations}
                      onSelectCitation={onSelectCitation}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      <TakeawaySnapshotModal
        open={snapshotOpen}
        briefing={briefing}
        onClose={() => setSnapshotOpen(false)}
        onSendToTasks={
          onSendTakeawaysToTasks
            ? () => {
                setSnapshotOpen(false);
                onSendTakeawaysToTasks();
              }
            : undefined
        }
      />

      <ShareBriefingModal
        open={shareModalOpen}
        briefing={briefing}
        onClose={() => setShareModalOpen(false)}
        onPreviewShare={onPreviewShare}
      />
    </div>
  );
}
