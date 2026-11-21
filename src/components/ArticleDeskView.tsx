import { useState } from 'react';
import {
  ArrowUpLeft,
  Bookmark,
  BookOpen,
  Box,
  Check,
  ExternalLink,
  FileText,
  Headphones,
  Link2,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  VOICE_OPTIONS,
  type BriefingPreferences,
  type BriefingTone,
  type BroadcastFormat,
  type CommuteDuration,
  type NewsArticle,
  type SourceType,
  type VoiceName,
  type VoiceTone,
} from '../types';
import { EDITION_COVER_IMAGE } from '../data/sampleArticles';

interface ArticleDeskViewProps {
  articles: NewsArticle[];
  readLaterArticles: NewsArticle[];
  preferences: BriefingPreferences;
  onPreferencesChange: (next: BriefingPreferences) => void;
  onOpenAddModal: (tab: 'upload' | 'url' | 'text') => void;
  onInspectSource: (sourceId: string) => void;
  onToggleArticle: (id: string) => void;
  onToggleAll: (selected: boolean) => void;
  onToggleReadLater: (id: string) => void;
  onRestoreAllReadLater: () => void;
  onRemoveArticle: (id: string) => void;
  onResetSamples: () => void;
  onBuildBriefing: (autoSynthesize: boolean) => Promise<void>;
  isGenerating: boolean;
  generationStatus: string | null;
  generationError: string | null;
  onProjectArticleTo3D?: (article: NewsArticle) => void;
}

const DURATION_OPTIONS: Array<{ value: CommuteDuration; label: string; note: string }> = [
  { value: 3, label: '3 min', note: 'Express' },
  { value: 5, label: '5 min', note: 'Standard' },
  { value: 10, label: '10 min', note: 'Deep Dive' },
];

const FORMAT_OPTIONS: Array<{ value: BroadcastFormat; label: string; desc: string }> = [
  { value: 'solo', label: 'Solo Anchor', desc: 'Single studio voice, crisp radio pace' },
  { value: 'podcast', label: 'Two-Host Podcast', desc: 'Alex & Sam dialogue with natural banter' },
];

const TONE_OPTIONS: Array<{ value: BriefingTone; label: string }> = [
  { value: 'executive', label: 'Executive' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'analytical', label: 'Analytical' },
  { value: 'upbeat', label: 'Upbeat' },
];

const VOICE_TONE_OPTIONS: Array<{
  value: VoiceTone;
  label: string;
  desc: string;
}> = [
  { value: 'professional', label: 'Professional', desc: 'Crisp, composed newsroom' },
  { value: 'casual', label: 'Casual', desc: 'Relaxed, friendly cadence' },
  { value: 'energetic', label: 'Energetic', desc: 'Upbeat, dynamic pace' },
  { value: 'soothing', label: 'Soothing', desc: 'Calm, gentle delivery' },
];

function formatSourceType(type?: SourceType): string {
  switch (type) {
    case 'pdf':
      return 'PDF Document';
    case 'docx':
      return 'Word (DOCX)';
    case 'markdown':
      return 'Markdown';
    case 'txt':
      return 'Text Note';
    default:
      return 'News Article';
  }
}

export function ArticleDeskView({
  articles,
  readLaterArticles,
  preferences,
  onPreferencesChange,
  onOpenAddModal,
  onInspectSource,
  onToggleArticle,
  onToggleAll,
  onToggleReadLater,
  onRestoreAllReadLater,
  onRemoveArticle,
  onResetSamples,
  onBuildBriefing,
  isGenerating,
  generationStatus,
  generationError,
  onProjectArticleTo3D,
}: ArticleDeskViewProps) {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const [deskTab, setDeskTab] = useState<'active' | 'readLater'>('active');

  const selectedArticles = articles.filter((a) => a.selected);
  const totalReadMinutes = selectedArticles.reduce(
    (sum, a) => sum + (a.estimatedReadMinutes || 3),
    0
  );

  const todayFormatted = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="max-w-[1180px] mx-auto px-5 sm:px-8 py-7 sm:py-9">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        {/* Left Main Editorial Desk (7 cols) */}
        <div className="xl:col-span-7 space-y-7">
          {/* Editorial Marquee Banner */}
          <section className="relative overflow-hidden rounded-lg border border-[#22D3EE]/30 bg-[#13161C]">
            <div className="relative aspect-[16/7] w-full">
              {!failedImages['cover'] ? (
                <img
                  src={EDITION_COVER_IMAGE}
                  alt="Morning commuter train window overlooking a city skyline at dawn"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedImages((prev) => ({ ...prev, cover: true }))}
                  className="w-full h-full object-cover opacity-80"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[#161D28] via-[#10141B] to-[#0B0D10]" />
              )}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-[#0B0D10] via-[#0B0D10]/55 to-transparent"
              />
              <div className="absolute inset-x-0 bottom-0 p-6 sm:p-7 flex flex-col justify-end">
                <p className="font-mono text-xs tracking-wider text-[#67E8F9] tabular-nums">
                  {todayFormatted} · Audio Research Notebook
                </p>
                <h1 className="mt-2 font-serif text-2xl sm:text-3xl font-medium text-[#F5F7FA] leading-tight max-w-xl">
                  Turn your documents and news queue into a cited audio briefing.
                </h1>
              </div>
            </div>
          </section>

          {/* Quick Add Sources Strip */}
          <section
            aria-label="Add documents or articles"
            className="bg-[#13161C] border border-[#22D3EE]/30 rounded-lg p-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
                  Add your own sources
                </h2>
                <p className="text-xs text-[#A0AABB] mt-0.5">
                  Upload PDF, Word (DOCX), TXT, or Markdown files—or queue any news link.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onOpenAddModal('upload')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  Upload File
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAddModal('url')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#181D26] hover:bg-[#1F2734] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Link2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Add URL
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAddModal('text')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#181D26] hover:bg-[#1F2734] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Paste Text
                </button>
              </div>
            </div>
          </section>

          {/* Active Sources & Read Later Workspace Overview */}
          <section aria-label="Queued sources">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#22D3EE]/35">
              <div className="flex flex-wrap items-center gap-4">
                <div
                  role="tablist"
                  aria-label="Desk source queue"
                  className="inline-flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={deskTab === 'active'}
                    onClick={() => setDeskTab('active')}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
                      deskTab === 'active'
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    Active Sources ({articles.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={deskTab === 'readLater'}
                    onClick={() => setDeskTab('readLater')}
                    className={`px-3 py-1 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
                      deskTab === 'readLater'
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <Bookmark className="w-3 h-3" aria-hidden="true" />
                    Read Later ({readLaterArticles.length})
                  </button>
                </div>

                {deskTab === 'active' ? (
                  <span className="text-xs font-mono text-[#8C96A8] tabular-nums">
                    {selectedArticles.length} selected · {totalReadMinutes} min source read
                  </span>
                ) : (
                  <span className="text-xs font-mono text-[#8C96A8]">
                    Shelved out of active briefings
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4 text-xs font-medium">
                {deskTab === 'active' ? (
                  <>
                    {articles.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onToggleAll(selectedArticles.length !== articles.length)
                        }
                        className="text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
                      >
                        {selectedArticles.length === articles.length
                          ? 'Deselect all'
                          : 'Select all'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onResetSamples}
                      className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      Load samples
                    </button>
                  </>
                ) : (
                  readLaterArticles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        onRestoreAllReadLater();
                        setDeskTab('active');
                      }}
                      className="inline-flex items-center gap-1.5 text-[#67E8F9] hover:text-[#22D3EE] whitespace-nowrap cursor-pointer"
                    >
                      <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      Move all to Notebook
                    </button>
                  )
                )}
              </div>
            </div>

            {deskTab === 'active' ? (
              articles.length === 0 ? (
                <div className="py-14 text-center border-b border-[#222833]">
                  <p className="font-serif text-lg text-[#F5F7FA]">
                    Active workspace is clear
                  </p>
                  <p className="mt-1.5 text-sm text-[#A0AABB] max-w-md mx-auto">
                    {readLaterArticles.length > 0
                      ? `You have ${readLaterArticles.length} ${readLaterArticles.length === 1 ? 'article' : 'articles'} saved in your Read Later queue. Restore them anytime or upload fresh sources.`
                      : 'Upload a PDF, Word document, Markdown note, or paste a news article URL—or load sample stories to try Dispatch immediately.'}
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    {readLaterArticles.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setDeskTab('readLater')}
                        className="px-4 py-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                      >
                        <Bookmark className="w-4 h-4" aria-hidden="true" />
                        View Read Later ({readLaterArticles.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenAddModal('upload')}
                      className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors cursor-pointer ${
                        readLaterArticles.length > 0
                          ? 'text-[#F5F7FA] border border-[#2C3546] hover:border-[#22D3EE]/60'
                          : 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9]'
                      }`}
                    >
                      Upload Document
                    </button>
                    <button
                      type="button"
                      onClick={onResetSamples}
                      className="px-4 py-2 text-sm font-medium text-[#F5F7FA] border border-[#2C3546] hover:border-[#22D3EE]/60 rounded-md transition-colors cursor-pointer"
                    >
                      Load 3 Samples
                    </button>
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-[#1E2430]">
                  {articles.map((article, index) => {
                    const hasWorkingImg =
                      Boolean(article.imageUrl) && !failedImages[article.id];
                    const passageCount = article.passages?.length || 0;

                    return (
                      <li
                        key={article.id}
                        className={`py-5 transition-opacity duration-150 ${
                          article.selected ? 'opacity-100' : 'opacity-50'
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={article.selected}
                            aria-label={`Include "${article.title}" in briefing`}
                            onClick={() => onToggleArticle(article.id)}
                            className={`mt-1 w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                              article.selected
                                ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                : 'bg-[#0E1116] border-[#394457] hover:border-[#22D3EE]'
                            }`}
                          >
                            {article.selected && <Check className="w-3.5 h-3.5" strokeWidth={2.75} />}
                          </button>

                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                              <span className="font-mono tabular-nums text-[#6E788A]">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-[#22D3EE]">
                                {formatSourceType(article.sourceType)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{article.category}</span>
                              <span aria-hidden="true">·</span>
                              <span className="truncate max-w-[180px]">{article.source}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {article.estimatedReadMinutes} min
                                {passageCount > 0 ? ` · ${passageCount} passages` : ''}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() => onInspectSource(article.id)}
                              className="mt-1.5 text-left font-serif text-lg font-medium text-[#F5F7FA] hover:text-[#67E8F9] transition-colors leading-snug cursor-pointer"
                            >
                              {article.title}
                            </button>

                            <p className="mt-2 text-sm text-[#A0AABB] leading-relaxed max-w-2xl">
                              {article.summary}
                            </p>

                            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                              <button
                                type="button"
                                onClick={() => onInspectSource(article.id)}
                                className="inline-flex items-center gap-1.5 font-medium text-[#67E8F9] hover:text-[#22D3EE] transition-colors cursor-pointer"
                              >
                                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                                Open Source Guide
                              </button>

                              <button
                                type="button"
                                onClick={() => onToggleReadLater(article.id)}
                                className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer"
                              >
                                <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                                Read Later
                              </button>

                              {onProjectArticleTo3D && (
                                <button
                                  type="button"
                                  onClick={() => onProjectArticleTo3D(article)}
                                  className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                                  3D Foil Card
                                </button>
                              )}

                              {article.url && (
                                <a
                                  href={article.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#F5F7FA] transition-colors"
                                >
                                  Source link
                                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                </a>
                              )}

                              <button
                                type="button"
                                onClick={() => onRemoveArticle(article.id)}
                                className="inline-flex items-center gap-1 text-[#6E788A] hover:text-[#F87171] transition-colors cursor-pointer ml-auto"
                              >
                                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                Remove
                              </button>
                            </div>
                          </div>

                          {article.imageUrl && (
                            <div className="hidden sm:block w-24 aspect-[4/3] rounded overflow-hidden border border-[#222833] bg-[#0E1116] shrink-0">
                              {hasWorkingImg ? (
                                <img
                                  src={article.imageUrl}
                                  alt={article.title}
                                  referrerPolicy="no-referrer"
                                  onError={() =>
                                    setFailedImages((prev) => ({
                                      ...prev,
                                      [article.id]: true,
                                    }))
                                  }
                                  className="w-full h-full object-cover opacity-90"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center font-serif text-lg text-[#6E788A]">
                                  {article.category.slice(0, 1)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : readLaterArticles.length === 0 ? (
              <div className="py-14 text-center border-b border-[#222833]">
                <Bookmark className="w-6 h-6 mx-auto text-[#394457]" aria-hidden="true" />
                <p className="mt-3 font-serif text-lg text-[#F5F7FA]">
                  Your Read Later queue is empty
                </p>
                <p className="mt-1.5 text-sm text-[#A0AABB] max-w-md mx-auto">
                  Click <span className="text-[#67E8F9]">Read Later</span> on any article in your Notebook or sidebar to set it aside without deleting it before building a briefing.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[#1E2430]">
                {readLaterArticles.map((article, index) => {
                  const passageCount = article.passages?.length || 0;
                  return (
                    <li key={article.id} className="py-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                            <span className="font-mono tabular-nums text-[#6E788A]">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-medium text-[#22D3EE]">
                              {formatSourceType(article.sourceType)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{article.category}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate max-w-[180px]">{article.source}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {article.estimatedReadMinutes} min
                              {passageCount > 0 ? ` · ${passageCount} passages` : ''}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => onInspectSource(article.id)}
                            className="mt-1.5 text-left font-serif text-lg font-medium text-[#F5F7FA] hover:text-[#67E8F9] transition-colors leading-snug cursor-pointer"
                          >
                            {article.title}
                          </button>

                          <p className="mt-2 text-sm text-[#A0AABB] leading-relaxed max-w-2xl">
                            {article.summary}
                          </p>

                          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                            <button
                              type="button"
                              onClick={() => onToggleReadLater(article.id)}
                              className="inline-flex items-center gap-1.5 font-medium text-[#22D3EE] hover:text-[#67E8F9] transition-colors cursor-pointer"
                            >
                              <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                              Move back to Notebook
                            </button>

                            <button
                              type="button"
                              onClick={() => onInspectSource(article.id)}
                              className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#F5F7FA] transition-colors cursor-pointer"
                            >
                              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                              Open Source Guide
                            </button>

                            {onProjectArticleTo3D && (
                              <button
                                type="button"
                                onClick={() => onProjectArticleTo3D(article)}
                                className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                                3D Foil Card
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => onRemoveArticle(article.id)}
                              className="inline-flex items-center gap-1 text-[#6E788A] hover:text-[#F87171] transition-colors cursor-pointer ml-auto"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Right Personalization Studio Panel (5 cols) */}
        <aside className="xl:col-span-5 xl:sticky xl:top-24 bg-[#13161C] border border-[#22D3EE]/35 rounded-lg p-6 space-y-6">
          <div className="pb-4 border-b border-[#222833]">
            <h2 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Briefing Studio
            </h2>
            <p className="text-sm text-[#A0AABB] mt-1">
              Tailor length, voice cast, and angle for your active sources.
            </p>
          </div>

          {/* Commute Duration */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[#F5F7FA]">
                Commute Length
              </label>
              <span className="text-xs font-mono text-[#67E8F9] tabular-nums">
                ~{preferences.durationMinutes} min audio
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
              {DURATION_OPTIONS.map((opt) => {
                const active = preferences.durationMinutes === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, durationMinutes: opt.value })
                    }
                    className={`py-2 px-2 rounded text-center transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#F5F7FA] border border-[#22D3EE]/55'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <span className="block text-sm font-semibold tabular-nums whitespace-nowrap">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-[#6E788A] whitespace-nowrap">
                      {opt.note}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Broadcast Format */}
          <div>
            <label className="block text-xs font-semibold text-[#F5F7FA] mb-2">
              Broadcast Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              {FORMAT_OPTIONS.map((opt) => {
                const active = preferences.format === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, format: opt.value })
                    }
                    className={`p-3 text-left rounded-md border transition-colors cursor-pointer ${
                      active
                        ? 'border-[#22D3EE]/70 bg-[#22D3EE]/[0.08]'
                        : 'border-[#222833] bg-[#0E1116] hover:border-[#394457]'
                    }`}
                  >
                    <span className="block text-sm font-medium text-[#F5F7FA] whitespace-nowrap">
                      {opt.label}
                    </span>
                    <span className="block text-xs text-[#8C96A8] mt-0.5 leading-snug">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Editorial Tone */}
          <div>
            <label className="block text-xs font-semibold text-[#F5F7FA] mb-2">
              Editorial Tone
            </label>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
              {TONE_OPTIONS.map((opt) => {
                const active = preferences.tone === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, tone: opt.value })
                    }
                    className={`py-2 px-3 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Voice Tone */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="block text-xs font-semibold text-[#F5F7FA]">
                Voice Tone
              </label>
              <span className="font-mono text-[11px] text-[#67E8F9] capitalize">
                {preferences.voiceTone || 'professional'}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Voice Tone"
              className="grid grid-cols-2 gap-2"
            >
              {VOICE_TONE_OPTIONS.map((opt) => {
                const active = (preferences.voiceTone || 'professional') === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      onPreferencesChange({ ...preferences, voiceTone: opt.value })
                    }
                    className={`px-3 py-2.5 text-left rounded-md border transition-colors cursor-pointer ${
                      active
                        ? 'border-[#22D3EE]/70 bg-[#22D3EE]/[0.08]'
                        : 'border-[#222833] bg-[#0E1116] hover:border-[#394457]'
                    }`}
                  >
                    <span
                      className={`block text-xs font-semibold whitespace-nowrap ${
                        active ? 'text-[#67E8F9]' : 'text-[#F5F7FA]'
                      }`}
                    >
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-[#8C96A8] mt-0.5 leading-snug">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Voice Cast + Newsroom Panel */}
          <div className="space-y-3.5">
            <div>
              <label
                htmlFor="lead-voice-select"
                className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
              >
                {preferences.format === 'podcast' ? 'Lead Host Voice (Alex)' : 'Anchor Voice'}
              </label>
              <select
                id="lead-voice-select"
                value={preferences.voiceName}
                onChange={(e) =>
                  onPreferencesChange({
                    ...preferences,
                    voiceName: e.target.value as VoiceName,
                  })
                }
                className="w-full h-10 px-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md focus:border-[#22D3EE]"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.descriptor}
                  </option>
                ))}
              </select>
            </div>

            {preferences.format === 'podcast' && (() => {
              const availableCoHosts = VOICE_OPTIONS.filter(
                (v) => v.name !== preferences.voiceName
              );

              const getAssignedVoice = (articleId: string, index: number): VoiceName => {
                const chosen = preferences.segmentCoHostVoices?.[articleId];
                if (chosen && chosen !== preferences.voiceName) {
                  return chosen;
                }
                return availableCoHosts[index % availableCoHosts.length].name;
              };

              const handleToggleDynamicPanel = (enable: boolean) => {
                if (!enable) {
                  onPreferencesChange({ ...preferences, dynamicPanel: false });
                  return;
                }
                const nextMap: Record<string, VoiceName> = {
                  ...(preferences.segmentCoHostVoices || {}),
                };
                selectedArticles.forEach((art, idx) => {
                  if (!nextMap[art.id] || nextMap[art.id] === preferences.voiceName) {
                    nextMap[art.id] = availableCoHosts[idx % availableCoHosts.length].name;
                  }
                });
                onPreferencesChange({
                  ...preferences,
                  dynamicPanel: true,
                  segmentCoHostVoices: nextMap,
                });
              };

              const handleAutoAssignUnique = () => {
                const nextMap: Record<string, VoiceName> = {
                  ...(preferences.segmentCoHostVoices || {}),
                };
                selectedArticles.forEach((art, idx) => {
                  nextMap[art.id] = availableCoHosts[idx % availableCoHosts.length].name;
                });
                onPreferencesChange({
                  ...preferences,
                  dynamicPanel: true,
                  segmentCoHostVoices: nextMap,
                });
              };

              const assignedSet = new Set(
                selectedArticles.map((art, idx) => getAssignedVoice(art.id, idx))
              );

              return (
                <div className="space-y-3 pt-1">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-[#F5F7FA]">
                        Co-Host Casting
                      </span>
                      {preferences.dynamicPanel && selectedArticles.length > 0 && (
                        <span className="font-mono text-[11px] text-[#67E8F9] tabular-nums">
                          {assignedSet.size} unique {assignedSet.size === 1 ? 'voice' : 'voices'}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
                      <button
                        type="button"
                        onClick={() => handleToggleDynamicPanel(false)}
                        className={`py-1.5 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                          !preferences.dynamicPanel
                            ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                            : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                        }`}
                      >
                        Single Co-Host
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleDynamicPanel(true)}
                        className={`py-1.5 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                          preferences.dynamicPanel
                            ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                            : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                        }`}
                      >
                        Newsroom Panel
                      </button>
                    </div>
                  </div>

                  {!preferences.dynamicPanel ? (
                    <div>
                      <label
                        htmlFor="cohost-voice-select"
                        className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
                      >
                        Co-Host Voice (Sam)
                      </label>
                      <select
                        id="cohost-voice-select"
                        value={preferences.coHostVoiceName}
                        onChange={(e) =>
                          onPreferencesChange({
                            ...preferences,
                            coHostVoiceName: e.target.value as VoiceName,
                          })
                        }
                        className="w-full h-10 px-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md focus:border-[#22D3EE]"
                      >
                        {availableCoHosts.map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name} — {v.descriptor}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-[#A0AABB]">
                          Assign a correspondent voice per segment
                        </p>
                        {selectedArticles.length > 1 && (
                          <button
                            type="button"
                            onClick={handleAutoAssignUnique}
                            className="text-xs font-medium text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Rotate voices
                          </button>
                        )}
                      </div>

                      {selectedArticles.length === 0 ? (
                        <p className="text-xs text-[#6E788A] py-2 border-t border-[#222833]">
                          Select sources in the sidebar to cast segment co-hosts.
                        </p>
                      ) : (
                        <ul className="divide-y divide-[#1F2532] border-t border-b border-[#222833]">
                          {selectedArticles.map((art, idx) => {
                            const currentVoice = getAssignedVoice(art.id, idx);
                            return (
                              <li
                                key={art.id}
                                className="py-2.5 flex items-center justify-between gap-3"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="font-mono text-[11px] text-[#6E788A] tabular-nums truncate">
                                    Seg {String(idx + 1).padStart(2, '0')} · {art.category}
                                  </p>
                                  <p
                                    className="text-xs font-medium text-[#F5F7FA] truncate"
                                    title={art.title}
                                  >
                                    {art.title}
                                  </p>
                                </div>
                                <label
                                  htmlFor={`panel-voice-${art.id}`}
                                  className="sr-only"
                                >
                                  Co-host voice for segment {idx + 1}: {art.title}
                                </label>
                                <select
                                  id={`panel-voice-${art.id}`}
                                  value={currentVoice}
                                  onChange={(e) => {
                                    const voice = e.target.value as VoiceName;
                                    onPreferencesChange({
                                      ...preferences,
                                      segmentCoHostVoices: {
                                        ...(preferences.segmentCoHostVoices || {}),
                                        [art.id]: voice,
                                      },
                                    });
                                  }}
                                  className="h-8 px-2 text-xs font-medium text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded focus:border-[#22D3EE] shrink-0"
                                >
                                  {availableCoHosts.map((v) => (
                                    <option key={v.name} value={v.name}>
                                      {v.name} ({v.register})
                                    </option>
                                  ))}
                                </select>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Personalized Introduction (Optional Custom Opening) */}
          <div>
            <label
              htmlFor="personalized-intro-input"
              className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
            >
              Personalized Introduction (optional)
            </label>
            <textarea
              id="personalized-intro-input"
              rows={2}
              value={preferences.personalizedIntroduction ?? ''}
              onChange={(e) =>
                onPreferencesChange({
                  ...preferences,
                  personalizedIntroduction: e.target.value,
                })
              }
              placeholder="e.g., Good morning — here is today's briefing tailored for our regional client review."
              className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-snug"
            />
          </div>

          {/* Listener Personalization Focus */}
          <div>
            <label
              htmlFor="listener-focus-input"
              className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
            >
              Personal Angle (optional)
            </label>
            <textarea
              id="listener-focus-input"
              rows={2}
              value={preferences.listenerFocus}
              onChange={(e) =>
                onPreferencesChange({
                  ...preferences,
                  listenerFocus: e.target.value,
                })
              }
              placeholder="e.g., Focus on financial risks, compare my uploaded PDF against the news stories."
              className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-snug"
            />
          </div>

          {/* Primary Action & Progress */}
          <div className="pt-2 space-y-2.5">
            <button
              type="button"
              disabled={isGenerating || selectedArticles.length === 0}
              onClick={() => onBuildBriefing(true)}
              className="w-full h-12 px-5 inline-flex items-center justify-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>{generationStatus || 'Building briefing...'}</span>
                </>
              ) : (
                <>
                  <Headphones className="w-4 h-4" aria-hidden="true" />
                  <span>Generate Audio Briefing</span>
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isGenerating || selectedArticles.length === 0}
              onClick={() => onBuildBriefing(false)}
              className="w-full py-2 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] disabled:opacity-40 transition-colors cursor-pointer"
            >
              Draft script first so I can review before recording
            </button>

            {generationError && (
              <p
                role="alert"
                className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2.5 leading-relaxed"
              >
                {generationError}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
