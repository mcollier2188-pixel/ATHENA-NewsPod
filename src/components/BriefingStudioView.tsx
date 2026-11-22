import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart2,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Globe,
  GripVertical,
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
import {
  DEFAULT_LOUDNESS_TARGET_LUFS,
  LOUDNESS_PRESETS,
  formatSignedDb,
  type LoudnessTargetPreset,
} from '../utils/audioNormalization';
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
  onReorderSegments: (fromIndex: number, toIndex: number) => void;
  onRefineScript: (instruction: string, targetSegmentId?: string) => Promise<void>;
  onSelectCitation: (citation: CitationRef) => void;
  onDownloadFullWav: () => void;
  onOpenCommuteMode: () => void;
  onPreviewShare: (shareId: string) => void;
  onProjectBriefingTo3D?: (briefing: AudioBriefing) => void;
  onOpenDriveExport?: () => void;
  loudnessNormEnabled?: boolean;
  loudnessTargetLufs?: LoudnessTargetPreset;
  onToggleLoudnessNorm?: () => void;
  onChangeLoudnessTarget?: (target: LoudnessTargetPreset) => void;
  onNormalizeRecordedChapters?: (target?: LoudnessTargetPreset) => void;
  onSendTakeawaysToTasks?: (indices?: number[]) => void;
}

const REFINE_PRESETS = [
  'Tighten pacing and cut filler by 20%',
  'Explain technical terms in plain English',
  'Make transitions between stories smoother',
];

interface SpeakerShareItem {
  speaker: string;
  voiceName: string;
  words: number;
  turns: number;
  pct: number;
  x: number;
  width: number;
  fillClass: string;
}

interface SegmentMetadataSummary {
  totalWords: number;
  lineCount: number;
  wordsPerMinute: number;
  speakers: SpeakerShareItem[];
  estimatedLufs: number;
  rawPreFilterEstLufs: number;
  measuredLufs: number | null;
  gainAppliedDb: number | null;
}

function countSpokenScriptWords(text: string): number {
  const cleaned = text
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|[^|]+\|/g, ' ')
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function computeSegmentMetadata(
  segment: BriefingSegment,
  briefing: AudioBriefing,
  durationSec: number,
  loudnessNormEnabled: boolean,
  loudnessTargetLufs: number
): SegmentMetadataSummary {
  const format = briefing.preferences.format;
  const primaryVoice = briefing.preferences.voiceName;
  const coHostVoice =
    segment.coHostVoiceName || briefing.preferences.coHostVoiceName;

  const speakerMap = new Map<
    string,
    { speaker: string; voiceName: string; words: number; turns: number }
  >();

  let totalWords = 0;
  let emphasisMarks = 0;

  for (const line of segment.lines) {
    const words = countSpokenScriptWords(line.text || '');
    totalWords += words;
    emphasisMarks += (line.text.match(/!/g) || []).length;

    const speakerKey =
      format === 'podcast' ? (line.speaker || 'Alex').trim() || 'Alex' : 'Anchor';
    const voiceName =
      format === 'podcast'
        ? speakerKey === 'Sam'
          ? coHostVoice
          : primaryVoice
        : primaryVoice;

    const existing = speakerMap.get(speakerKey);
    if (existing) {
      existing.words += words;
      existing.turns += 1;
    } else {
      speakerMap.set(speakerKey, {
        speaker: speakerKey,
        voiceName,
        words,
        turns: 1,
      });
    }
  }

  if (speakerMap.size === 0) {
    speakerMap.set(format === 'podcast' ? 'Alex' : 'Anchor', {
      speaker: format === 'podcast' ? 'Alex' : 'Anchor',
      voiceName: primaryVoice,
      words: 0,
      turns: 0,
    });
  }

  const rawSpeakers = Array.from(speakerMap.values());
  const denominator =
    totalWords > 0
      ? totalWords
      : Math.max(
          1,
          rawSpeakers.reduce((sum, item) => sum + item.turns, 0)
        );

  // Exact integer percentages summing to 100%
  const rawPcts = rawSpeakers.map((item) => {
    const metric = totalWords > 0 ? item.words : item.turns;
    return (metric / denominator) * 100;
  });
  const roundedPcts = rawPcts.map((p) => Math.floor(p));
  let remainder = 100 - roundedPcts.reduce((sum, p) => sum + p, 0);
  const byFraction = rawPcts
    .map((p, idx) => ({ idx, frac: p - Math.floor(p) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < byFraction.length && remainder > 0; i++) {
    roundedPcts[byFraction[i].idx] += 1;
    remainder -= 1;
  }

  const palette = [
    'fill-[#22D3EE]',
    'fill-[#818CF8]',
    'fill-[#38BDF8]',
    'fill-[#34D399]',
  ];
  const gapUnits = rawSpeakers.length > 1 ? 6 : 0;
  const usableWidth = Math.max(
    100,
    1000 - gapUnits * Math.max(0, rawSpeakers.length - 1)
  );
  let cursorX = 0;

  const speakers: SpeakerShareItem[] = rawSpeakers.map((item, idx) => {
    const shareRatio =
      totalWords > 0
        ? item.words / denominator
        : rawSpeakers.length > 0
          ? 1 / rawSpeakers.length
          : 1;
    const rawW = shareRatio * usableWidth;
    const width =
      idx === rawSpeakers.length - 1
        ? Math.max(8, 1000 - cursorX)
        : Math.max(8, rawW);
    const x = cursorX;
    cursorX += width + gapUnits;

    return {
      ...item,
      pct: roundedPcts[idx] ?? 0,
      x,
      width,
      fillClass:
        item.speaker === 'Sam'
          ? 'fill-[#818CF8]'
          : palette[idx % palette.length],
    };
  });

  // Estimate natural pre-filter TTS loudness from voiceTone, speaker voices, and cadence
  const toneBaseLufs: Record<string, number> = {
    soothing: -20.0,
    casual: -18.3,
    professional: -17.5,
    energetic: -15.8,
  };
  const voiceOffsetLu: Record<string, number> = {
    Charon: -0.4,
    Zephyr: -0.2,
    Kore: 0.0,
    Puck: 0.2,
    Fenrir: 0.4,
  };

  const baseToneLufs =
    toneBaseLufs[briefing.preferences.voiceTone || 'professional'] ?? -17.5;
  const weightedVoiceOffset = speakers.reduce((sum, sp) => {
    const offset = voiceOffsetLu[sp.voiceName] ?? 0;
    return sum + offset * (sp.pct / 100);
  }, 0);
  const emphasisBoost = Math.min(
    0.5,
    (emphasisMarks / Math.max(1, segment.lines.length)) * 0.2
  );
  const rawPreFilterEstLufs =
    Math.round(
      Math.max(-23, Math.min(-14, baseToneLufs + weightedVoiceOffset + emphasisBoost)) *
        10
    ) / 10;

  const estimatedLufs = loudnessNormEnabled
    ? loudnessTargetLufs
    : rawPreFilterEstLufs;

  const measuredLufs =
    segment.audioBase64 && !segment.audioStale && typeof segment.loudnessLufs === 'number'
      ? segment.loudnessLufs
      : null;

  const gainAppliedDb =
    segment.audioBase64 && !segment.audioStale && typeof segment.gainAppliedDb === 'number'
      ? segment.gainAppliedDb
      : null;

  const safeDur = Math.max(10, durationSec || 60);
  const wordsPerMinute =
    totalWords > 0 ? Math.round((totalWords / safeDur) * 60) : 0;

  return {
    totalWords,
    lineCount: segment.lines.length,
    wordsPerMinute,
    speakers,
    estimatedLufs,
    rawPreFilterEstLufs,
    measuredLufs,
    gainAppliedDb,
  };
}

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
  onReorderSegments,
  onRefineScript,
  onSelectCitation,
  onDownloadFullWav,
  onOpenCommuteMode,
  onPreviewShare,
  onProjectBriefingTo3D,
  onOpenDriveExport,
  loudnessNormEnabled = true,
  loudnessTargetLufs = DEFAULT_LOUDNESS_TARGET_LUFS,
  onToggleLoudnessNorm,
  onChangeLoudnessTarget,
  onNormalizeRecordedChapters,
  onSendTakeawaysToTasks,
}: BriefingStudioViewProps) {
  const [refinePrompt, setRefinePrompt] = useState('');
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [draftLines, setDraftLines] = useState<ScriptLine[]>([]);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  // Segment metadata toggle state (word count, speaker distribution, estimated loudness)
  const [showAllSegmentMetadata, setShowAllSegmentMetadata] = useState<boolean>(
    () => {
      try {
        return localStorage.getItem('dispatch_show_segment_metadata') === 'true';
      } catch {
        return false;
      }
    }
  );
  const [segmentMetadataOverrides, setSegmentMetadataOverrides] = useState<
    Record<string, boolean>
  >({});

  // Drag-and-drop chapter reordering state
  const [dragArmedSegmentId, setDragArmedSegmentId] = useState<string | null>(null);
  const [draggingSegmentId, setDraggingSegmentId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{
    segmentId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dragHandleRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Full-text transcript search state
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyMatchingChapters, setOnlyMatchingChapters] = useState(false);
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const segmentRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (!dragArmedSegmentId) return;
    const clearArmed = () => {
      if (!draggingSegmentId) {
        setDragArmedSegmentId(null);
      }
    };
    window.addEventListener('mouseup', clearArmed);
    window.addEventListener('touchend', clearArmed);
    return () => {
      window.removeEventListener('mouseup', clearArmed);
      window.removeEventListener('touchend', clearArmed);
    };
  }, [dragArmedSegmentId, draggingSegmentId]);

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
  const freshAudioCount = briefing.segments.filter(
    (s) => Boolean(s.audioBase64) && !s.audioStale
  ).length;
  const staleAudioCount = briefing.segments.filter(
    (s) => Boolean(s.audioBase64) && Boolean(s.audioStale)
  ).length;
  const allAudioReady =
    freshAudioCount === briefing.segments.length && briefing.segments.length > 0;
  const hasStaleOrMissing = briefing.segments.some((s) => !s.audioBase64 || s.audioStale);
  const totalSeconds = briefing.segments.reduce(
    (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
    0
  );
  const synthesizedSeconds = briefing.segments.reduce(
    (sum, s) =>
      Boolean(s.audioBase64) && !s.audioStale
        ? sum + (s.audioDurationSeconds || s.estimatedSeconds || 60)
        : sum,
    0
  );
  const staleSeconds = briefing.segments.reduce(
    (sum, s) =>
      Boolean(s.audioBase64) && Boolean(s.audioStale)
        ? sum + (s.audioDurationSeconds || s.estimatedSeconds || 60)
        : sum,
    0
  );
  const pendingSeconds = Math.max(0, totalSeconds - synthesizedSeconds);
  const synthesisPct =
    totalSeconds > 0
      ? Math.min(100, Math.round((synthesizedSeconds / totalSeconds) * 100))
      : 0;
  const synthesizingIndex = synthesizingSegmentId
    ? briefing.segments.findIndex((s) => s.id === synthesizingSegmentId)
    : -1;
  const synthesizingSegment =
    synthesizingIndex >= 0 ? briefing.segments[synthesizingIndex] : null;
  const isActivelySynthesizing = isSynthesizingAll || synthesizingIndex >= 0;

  const synthesisSlices = (() => {
    const count = briefing.segments.length;
    if (count === 0) return [];
    const gapUnits = count > 1 ? 3 : 0;
    const usableWidth = Math.max(100, 1000 - gapUnits * (count - 1));
    const safeTotal = Math.max(1, totalSeconds);
    let cursorX = 0;
    let cumulativeSec = 0;

    return briefing.segments.map((segment, index) => {
      const durationSec = Math.max(
        1,
        segment.audioDurationSeconds || segment.estimatedSeconds || 60
      );
      const startSec = cumulativeSec;
      cumulativeSec += durationSec;
      const rawWidth = (durationSec / safeTotal) * usableWidth;
      const width =
        index === count - 1
          ? Math.max(4, 1000 - cursorX)
          : Math.max(4, rawWidth);
      const x = cursorX;
      cursorX += width + gapUnits;

      const isFresh = Boolean(segment.audioBase64) && !segment.audioStale;
      const isStale = Boolean(segment.audioBase64) && Boolean(segment.audioStale);
      const isSynthesizing = synthesizingSegmentId === segment.id;

      return {
        segment,
        index,
        x,
        width,
        durationSec,
        startSec,
        endSec: cumulativeSec,
        isFresh,
        isStale,
        isSynthesizing,
      };
    });
  })();

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

  const isFilteredSubset = Boolean(normalizedQuery && onlyMatchingChapters);
  const canReorderChapters =
    briefing.segments.length > 1 &&
    !isFilteredSubset &&
    !editingSegmentId &&
    !isSynthesizingAll;

  function resetDragState() {
    setDraggingSegmentId(null);
    setDragArmedSegmentId(null);
    setDragOverTarget(null);
  }

  function handleChapterDragStart(
    e: DragEvent<HTMLElement>,
    segmentId: string,
    index: number
  ) {
    if (!canReorderChapters || dragArmedSegmentId !== segmentId) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    setDraggingSegmentId(segmentId);
  }

  function handleChapterDragOver(
    e: DragEvent<HTMLElement>,
    segmentId: string
  ) {
    if (!canReorderChapters || !draggingSegmentId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggingSegmentId === segmentId) {
      if (dragOverTarget !== null) setDragOverTarget(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    if (
      dragOverTarget?.segmentId !== segmentId ||
      dragOverTarget.position !== position
    ) {
      setDragOverTarget({ segmentId, position });
    }
  }

  function handleChapterDrop(
    e: DragEvent<HTMLElement>,
    hoverIndex: number
  ) {
    if (!canReorderChapters || !briefing) return;
    e.preventDefault();

    const fromIndex = draggingSegmentId
      ? briefing.segments.findIndex((s) => s.id === draggingSegmentId)
      : Number.parseInt(e.dataTransfer.getData('text/plain'), 10);

    const rect = e.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' =
      dragOverTarget?.position ??
      (e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');

    resetDragState();

    if (!Number.isFinite(fromIndex) || fromIndex < 0) return;
    const insertBeforeIndex = position === 'before' ? hoverIndex : hoverIndex + 1;
    const toIndex =
      fromIndex < insertBeforeIndex ? insertBeforeIndex - 1 : insertBeforeIndex;

    if (toIndex !== fromIndex) {
      onReorderSegments(fromIndex, toIndex);
    }
  }

  function moveChapterByStep(segmentId: string, fromIndex: number, delta: -1 | 1) {
    if (!canReorderChapters || !briefing) return;
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= briefing.segments.length) return;
    onReorderSegments(fromIndex, toIndex);
    window.requestAnimationFrame(() => {
      dragHandleRefs.current[segmentId]?.focus();
    });
  }

  function handleDragHandleKeyDown(
    e: KeyboardEvent<HTMLButtonElement>,
    segmentId: string,
    index: number
  ) {
    if (!canReorderChapters) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveChapterByStep(segmentId, index, -1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveChapterByStep(segmentId, index, 1);
    }
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

        {briefing.segments.length > 0 && (
          <div className="mt-6 pt-5 border-t border-[#1F2532]">
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
              <div
                aria-live="polite"
                className="flex items-center gap-2 min-w-0 text-xs text-[#A0AABB]"
              >
                {isActivelySynthesizing ? (
                  <>
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin text-[#22D3EE] shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-[#F5F7FA] truncate">
                      {synthesizingSegment
                        ? `Synthesizing Chapter ${String(synthesizingIndex + 1).padStart(2, '0')} of ${String(briefing.segments.length).padStart(2, '0')}: ${synthesizingSegment.title}`
                        : 'Synthesizing briefing chapters...'}
                    </span>
                  </>
                ) : allAudioReady ? (
                  <>
                    <Check
                      className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-[#E4E9F1]">
                      All {briefing.segments.length}{' '}
                      {briefing.segments.length === 1 ? 'chapter' : 'chapters'} synthesized
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-[#E4E9F1]">
                    Chapter Synthesis Progress · {freshAudioCount} of{' '}
                    {briefing.segments.length} ready
                  </span>
                )}
              </div>

              <div className="font-mono text-xs tabular-nums whitespace-nowrap shrink-0">
                <span className="text-[#F5F7FA] font-medium">
                  {formatClock(synthesizedSeconds)}
                </span>
                <span className="text-[#8C96A8]"> synthesized / </span>
                <span className="text-[#22D3EE] font-semibold">
                  {formatClock(totalSeconds)} total
                </span>
                <span className="text-[#8C96A8]" aria-hidden="true">
                  {' '}
                  ·{' '}
                </span>
                <span className="text-[#A0AABB]">{synthesisPct}%</span>
              </div>
            </div>

            <div
              role="progressbar"
              aria-label="Briefing audio synthesis duration progress"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, Math.round(totalSeconds))}
              aria-valuenow={Math.round(synthesizedSeconds)}
              aria-valuetext={`${formatClock(synthesizedSeconds)} synthesized of ${formatClock(totalSeconds)} total briefing duration (${synthesisPct}%, ${freshAudioCount} of ${briefing.segments.length} chapters ready)`}
              className="mt-2.5"
            >
              <svg
                viewBox="0 0 1000 12"
                preserveAspectRatio="none"
                className="w-full h-3 rounded bg-[#0E1116] border border-[#232B38] block"
              >
                {synthesisSlices.map((slice) => {
                  const chapterNum = String(slice.index + 1).padStart(2, '0');
                  const statusLabel = slice.isSynthesizing
                    ? `Synthesizing (~${formatClock(slice.durationSec)} est.)`
                    : slice.isFresh
                      ? `Synthesized (${formatClock(slice.durationSec)})`
                      : slice.isStale
                        ? `Edited, re-record needed (~${formatClock(slice.durationSec)})`
                        : `Pending (~${formatClock(slice.durationSec)} est.)`;
                  const fillClass = slice.isSynthesizing
                    ? 'fill-[#38BDF8] animate-pulse motion-reduce:animate-none'
                    : slice.isFresh
                      ? 'fill-[#22D3EE] hover:fill-[#67E8F9]'
                      : slice.isStale
                        ? 'fill-[#FBBF24] hover:fill-[#FCD34D]'
                        : 'fill-[#1C2433] hover:fill-[#273247]';

                  const handleSelectSlice = () => {
                    const el = segmentRefs.current[slice.segment.id];
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                    if (slice.segment.audioBase64) {
                      onPlaySegment(slice.index);
                    }
                  };

                  return (
                    <g
                      key={slice.segment.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Chapter ${chapterNum}: ${slice.segment.title} — ${statusLabel}`}
                      onClick={handleSelectSlice}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectSlice();
                        }
                      }}
                      className="cursor-pointer focus:outline-none"
                    >
                      <title>{`Ch. ${chapterNum} · ${slice.segment.title} — ${statusLabel} (${formatClock(slice.startSec)}–${formatClock(slice.endSec)})`}</title>
                      {slice.isSynthesizing && (
                        <rect
                          x={slice.x}
                          y={0}
                          width={slice.width}
                          height={12}
                          className="fill-[#142836]"
                        />
                      )}
                      <rect
                        x={slice.x}
                        y={0}
                        width={slice.width}
                        height={12}
                        className={`transition-opacity duration-150 ${fillClass}`}
                      />
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-[#8C96A8] tabular-nums">
              <span>
                Exact recorded:{' '}
                <span className="text-[#D5DCE6]">{formatClock(synthesizedSeconds)}</span>
              </span>
              {synthesizingSegment && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#67E8F9]">
                    Active Ch. {String(synthesizingIndex + 1).padStart(2, '0')}: ~
                    {formatClock(
                      synthesizingSegment.audioDurationSeconds ||
                        synthesizingSegment.estimatedSeconds ||
                        60
                    )}
                  </span>
                </>
              )}
              {pendingSeconds > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Est. remaining: {formatClock(pendingSeconds)}</span>
                </>
              )}
              {staleAudioCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#FBBF24]">
                    {staleAudioCount} edited ({formatClock(staleSeconds)} to update)
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>Target commute: {briefing.preferences.durationMinutes}:00</span>
            </div>

            {/* Broadcast Loudness Normalization Filter Bar */}
            {(() => {
              const measuredValues = briefing.segments
                .filter((s) => Boolean(s.audioBase64) && typeof s.loudnessLufs === 'number')
                .map((s) => s.loudnessLufs as number);
              const avgLufs =
                measuredValues.length > 0
                  ? measuredValues.reduce((sum, v) => sum + v, 0) / measuredValues.length
                  : null;
              const maxSpreadLu =
                measuredValues.length > 1
                  ? (Math.max(...measuredValues) - Math.min(...measuredValues)) / 2
                  : 0;
              const needsInPlaceLeveling =
                loudnessNormEnabled &&
                readyAudioCount > 0 &&
                briefing.segments.some(
                  (s) =>
                    Boolean(s.audioBase64) &&
                    s.audioBase64 !== 'hosted' &&
                    (typeof s.loudnessLufs !== 'number' ||
                      Math.abs(s.loudnessLufs - loudnessTargetLufs) > 0.8)
                );

              return (
                <div className="mt-4 pt-3.5 border-t border-[#1A202C] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {onToggleLoudnessNorm ? (
                      <button
                        type="button"
                        aria-pressed={loudnessNormEnabled}
                        onClick={onToggleLoudnessNorm}
                        className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          loudnessNormEnabled
                            ? 'bg-[#13222B] text-[#67E8F9] border-[#22D3EE]/55 hover:border-[#22D3EE]'
                            : 'bg-[#0E1116] text-[#8C96A8] border-[#273040] hover:text-[#F5F7FA]'
                        }`}
                      >
                        <Volume2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                        Loudness Filter: {loudnessNormEnabled ? 'On' : 'Off'}
                      </button>
                    ) : (
                      <span className="text-xs font-medium text-[#E4E9F1]">
                        Loudness Filter: {loudnessNormEnabled ? 'On' : 'Off'}
                      </span>
                    )}

                    {loudnessNormEnabled && onChangeLoudnessTarget && (
                      <div className="inline-flex items-center gap-1.5">
                        <label
                          htmlFor="loudness-target-select"
                          className="sr-only"
                        >
                          Target podcast loudness
                        </label>
                        <select
                          id="loudness-target-select"
                          value={loudnessTargetLufs}
                          disabled={isActivelySynthesizing}
                          onChange={(e) => {
                            const nextTarget = Number(
                              e.target.value
                            ) as LoudnessTargetPreset;
                            onChangeLoudnessTarget(nextTarget);
                            if (onNormalizeRecordedChapters && readyAudioCount > 0) {
                              onNormalizeRecordedChapters(nextTarget);
                            }
                          }}
                          className="h-8 px-2.5 font-mono text-xs text-[#F5F7FA] bg-[#0E1116] border border-[#273040] hover:border-[#22D3EE]/50 rounded-md focus:border-[#22D3EE] tabular-nums disabled:opacity-45 cursor-pointer"
                        >
                          {LOUDNESS_PRESETS.map((preset) => (
                            <option key={preset.targetLufs} value={preset.targetLufs}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {needsInPlaceLeveling && onNormalizeRecordedChapters && (
                      <button
                        type="button"
                        disabled={isActivelySynthesizing}
                        onClick={() => onNormalizeRecordedChapters(loudnessTargetLufs)}
                        className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/45 hover:border-[#22D3EE] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                        Level Recorded Audio
                      </button>
                    )}
                  </div>

                  <div className="font-mono text-xs text-[#8C96A8] tabular-nums whitespace-nowrap">
                    {avgLufs !== null ? (
                      <>
                        <span>
                          Avg{' '}
                          <span className="text-[#D5DCE6]">{avgLufs.toFixed(1)} LUFS</span>
                        </span>
                        {measuredValues.length > 1 && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>±{maxSpreadLu.toFixed(1)} LU spread</span>
                          </>
                        )}
                        <span aria-hidden="true"> · </span>
                        <span>-1.0 dBFS ceiling</span>
                      </>
                    ) : (
                      <span>
                        Target {loudnessTargetLufs} LUFS · -1.0 dBFS peak limiter
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}
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

          {briefing.segments.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-[#8C96A8] px-0.5">
              <span>
                {briefing.segments.length > 1
                  ? isFilteredSubset
                    ? 'Clear Matches only filter to reorder podcast chapters'
                    : 'Drag chapters by the grip handle or use the arrow buttons to reorder podcast flow'
                  : 'Single-chapter briefing edition'}
              </span>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-pressed={
                    briefing.segments.every(
                      (s) => segmentMetadataOverrides[s.id] ?? showAllSegmentMetadata
                    )
                  }
                  onClick={() => {
                    const allOpen = briefing.segments.every(
                      (s) => segmentMetadataOverrides[s.id] ?? showAllSegmentMetadata
                    );
                    const next = !allOpen;
                    setShowAllSegmentMetadata(next);
                    setSegmentMetadataOverrides({});
                    try {
                      localStorage.setItem(
                        'dispatch_show_segment_metadata',
                        String(next)
                      );
                    } catch {
                      // ignore storage errors
                    }
                  }}
                  className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    briefing.segments.some(
                      (s) => segmentMetadataOverrides[s.id] ?? showAllSegmentMetadata
                    )
                      ? 'bg-[#13222B] text-[#67E8F9] border-[#22D3EE]/55 hover:border-[#22D3EE]'
                      : 'bg-[#13161C] text-[#A0AABB] border-[#273040] hover:text-[#F5F7FA] hover:border-[#22D3EE]/45'
                  }`}
                >
                  <BarChart2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Segment Metadata
                </button>

                <span className="font-mono tabular-nums text-[#6E788A] whitespace-nowrap">
                  {briefing.segments.length}{' '}
                  {briefing.segments.length === 1 ? 'chapter' : 'chapters'}
                </span>
              </div>
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
            const isDraggingThis = draggingSegmentId === segment.id;
            const dropPosition =
              dragOverTarget?.segmentId === segment.id && !isDraggingThis
                ? dragOverTarget.position
                : null;
            const isMetadataOpen =
              segmentMetadataOverrides[segment.id] ?? showAllSegmentMetadata;
            const segmentMeta = isMetadataOpen
              ? computeSegmentMetadata(
                  segment,
                  briefing,
                  durationSec,
                  loudnessNormEnabled,
                  loudnessTargetLufs
                )
              : null;

            return (
              <article
                key={segment.id}
                ref={(el) => {
                  segmentRefs.current[segment.id] = el;
                }}
                draggable={canReorderChapters && dragArmedSegmentId === segment.id}
                onDragStart={(e) => handleChapterDragStart(e, segment.id, index)}
                onDragOver={(e) => handleChapterDragOver(e, segment.id)}
                onDrop={(e) => handleChapterDrop(e, index)}
                onDragEnd={resetDragState}
                className={`relative scroll-mt-24 bg-[#13161C] border rounded-lg p-6 transition-[transform,opacity,border-color] duration-150 ${
                  isDraggingThis
                    ? 'opacity-55 scale-[0.99] border-[#22D3EE]'
                    : dropPosition
                      ? 'border-[#22D3EE]/85'
                      : isCurrent && segment.audioBase64
                        ? 'border-[#22D3EE] cyan-rim-strong'
                        : normalizedQuery && segmentMatchCount > 0
                          ? 'border-[#22D3EE]/50'
                          : 'border-[#222833] hover:border-[#22D3EE]/35'
                }`}
              >
                {dropPosition === 'before' && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-3.5 left-0 right-0 h-0.5 bg-[#22D3EE]"
                  />
                )}
                {dropPosition === 'after' && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-3.5 left-0 right-0 h-0.5 bg-[#22D3EE]"
                  />
                )}

                {/* Chapter Header */}
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-4 border-b border-[#222833]">
                  <div className="flex items-start gap-3 min-w-0">
                    {briefing.segments.length > 1 && (
                      <button
                        type="button"
                        ref={(el) => {
                          dragHandleRefs.current[segment.id] = el;
                        }}
                        disabled={!canReorderChapters}
                        onMouseDown={() => {
                          if (canReorderChapters) {
                            setDragArmedSegmentId(segment.id);
                          }
                        }}
                        onTouchStart={() => {
                          if (canReorderChapters) {
                            setDragArmedSegmentId(segment.id);
                          }
                        }}
                        onKeyDown={(e) =>
                          handleDragHandleKeyDown(e, segment.id, index)
                        }
                        aria-label={`Reorder Chapter ${index + 1}: ${segment.title}. Press Up or Down arrow keys, or drag to reorder.`}
                        title={
                          canReorderChapters
                            ? 'Drag to reorder chapter (or press Up / Down arrows)'
                            : isFilteredSubset
                              ? 'Clear search filter to reorder chapters'
                              : 'Finish editing or recording to reorder chapters'
                        }
                        className="mt-0.5 w-8 h-9 shrink-0 inline-flex items-center justify-center text-[#6E788A] hover:text-[#67E8F9] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#22D3EE] rounded-md cursor-grab active:cursor-grabbing disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                      >
                        <GripVertical className="w-4 h-4" aria-hidden="true" />
                      </button>
                    )}

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
                        {segment.audioBase64 &&
                          typeof segment.loudnessLufs === 'number' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-[#A0AABB]">
                                {segment.loudnessLufs.toFixed(1)} LUFS
                                {typeof segment.gainAppliedDb === 'number' &&
                                Math.abs(segment.gainAppliedDb) >= 0.1
                                  ? ` (${formatSignedDb(segment.gainAppliedDb)})`
                                  : ''}
                              </span>
                            </>
                          )}
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
                  </div>

                  {/* Chapter Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {briefing.segments.length > 1 && !isEditingThis && (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!canReorderChapters || index === 0}
                          onClick={() => moveChapterByStep(segment.id, index, -1)}
                          aria-label={`Move Chapter ${index + 1} up`}
                          title="Move chapter earlier"
                          className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-35 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          disabled={
                            !canReorderChapters ||
                            index === briefing.segments.length - 1
                          }
                          onClick={() => moveChapterByStep(segment.id, index, 1)}
                          aria-label={`Move Chapter ${index + 1} down`}
                          title="Move chapter later"
                          className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-35 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    )}

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
                      <>
                        <button
                          type="button"
                          aria-expanded={isMetadataOpen}
                          onClick={() =>
                            setSegmentMetadataOverrides((prev) => ({
                              ...prev,
                              [segment.id]: !isMetadataOpen,
                            }))
                          }
                          className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            isMetadataOpen
                              ? 'bg-[#13222B] text-[#67E8F9] border-[#22D3EE]/55'
                              : 'text-[#A0AABB] hover:text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/50'
                          }`}
                        >
                          <BarChart2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                          Metadata
                        </button>

                        <button
                          type="button"
                          onClick={() => startEditing(segment)}
                          className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Collapsible Per-Segment Metadata Strip (Word Count · Speaker Distribution · Estimated Loudness) */}
                {segmentMeta && (
                  <div
                    aria-label={`Chapter ${index + 1} metadata`}
                    className="py-3.5 border-b border-[#222833] space-y-2.5"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                      {/* 1. Word Count & Pacing */}
                      <div>
                        <p className="text-[#8C96A8]">Word Count &amp; Pace</p>
                        <p className="mt-0.5 font-mono text-[#F5F7FA] tabular-nums">
                          <span className="font-semibold">
                            {segmentMeta.totalWords.toLocaleString()}
                          </span>{' '}
                          {segmentMeta.totalWords === 1 ? 'word' : 'words'}
                          <span className="text-[#6E788A]" aria-hidden="true">
                            {' '}
                            ·{' '}
                          </span>
                          <span className="text-[#A0AABB]">
                            {segmentMeta.lineCount}{' '}
                            {segmentMeta.lineCount === 1 ? 'turn' : 'turns'}
                          </span>
                          {segmentMeta.wordsPerMinute > 0 && (
                            <>
                              <span className="text-[#6E788A]" aria-hidden="true">
                                {' '}
                                ·{' '}
                              </span>
                              <span className="text-[#A0AABB]">
                                ~{segmentMeta.wordsPerMinute} wpm
                              </span>
                            </>
                          )}
                        </p>
                      </div>

                      {/* 2. Speaker Distribution */}
                      <div>
                        <p className="text-[#8C96A8]">Speaker Distribution</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[#F5F7FA] tabular-nums">
                          {segmentMeta.speakers.map((sp, spIdx) => (
                            <span key={sp.speaker} className="whitespace-nowrap">
                              {spIdx > 0 && (
                                <span className="text-[#6E788A] mr-2" aria-hidden="true">
                                  ·
                                </span>
                              )}
                              <span
                                className={
                                  sp.speaker === 'Sam'
                                    ? 'text-[#A5B4FC] font-medium'
                                    : 'text-[#67E8F9] font-medium'
                                }
                              >
                                {sp.speaker}
                              </span>{' '}
                              <span className="text-[#8C96A8]">({sp.voiceName})</span>{' '}
                              <span className="font-semibold">{sp.pct}%</span>{' '}
                              <span className="text-[#8C96A8]">({sp.words}w)</span>
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* 3. Estimated & Measured Loudness */}
                      <div>
                        <p className="text-[#8C96A8]">
                          {segmentMeta.measuredLufs !== null
                            ? 'Estimated & Measured Loudness'
                            : 'Estimated Loudness'}
                        </p>
                        <p className="mt-0.5 font-mono text-[#F5F7FA] tabular-nums">
                          <span>
                            Est.{' '}
                            <span className="font-semibold text-[#67E8F9]">
                              {segmentMeta.estimatedLufs.toFixed(1)} LUFS
                            </span>
                          </span>
                          {segmentMeta.measuredLufs !== null ? (
                            <>
                              <span className="text-[#6E788A]" aria-hidden="true">
                                {' '}
                                ·{' '}
                              </span>
                              <span className="text-[#D5DCE6]">
                                Actual {segmentMeta.measuredLufs.toFixed(1)} LUFS
                                {segmentMeta.gainAppliedDb !== null &&
                                Math.abs(segmentMeta.gainAppliedDb) >= 0.1
                                  ? ` (${formatSignedDb(segmentMeta.gainAppliedDb)})`
                                  : ''}
                              </span>
                            </>
                          ) : loudnessNormEnabled ? (
                            <>
                              <span className="text-[#6E788A]" aria-hidden="true">
                                {' '}
                                ·{' '}
                              </span>
                              <span className="text-[#8C96A8]">
                                raw ~{segmentMeta.rawPreFilterEstLufs.toFixed(1)} LUFS
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-[#6E788A]" aria-hidden="true">
                                {' '}
                                ·{' '}
                              </span>
                              <span className="text-[#8C96A8]">unfiltered</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Proportional Speaker Share Bar (SVG — zero inline styles) */}
                    <svg
                      viewBox="0 0 1000 6"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      className="w-full h-1.5 rounded bg-[#0E1116] block overflow-hidden"
                    >
                      {segmentMeta.speakers.map((sp) => (
                        <rect
                          key={sp.speaker}
                          x={sp.x}
                          y={0}
                          width={sp.width}
                          height={6}
                          className={sp.fillClass}
                        />
                      ))}
                    </svg>
                  </div>
                )}

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
