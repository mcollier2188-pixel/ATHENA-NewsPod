import { useState } from 'react';
import { Headphones, Loader2, Rss, Trash2 } from 'lucide-react';
import type { AudioBriefing, LocalRssFeedConfig, PlaybackPosition } from '../types';
import { formatClock } from '../utils/wavUtils';
import { ArchiveSummaryDashboard } from './ArchiveSummaryDashboard';
import { PrivateRssFeedModal } from './PrivateRssFeedModal';

interface ArchiveViewProps {
  archive: AudioBriefing[];
  activeBriefingId: string | null;
  playbackPositions: Record<string, PlaybackPosition>;
  rssFeedConfig: LocalRssFeedConfig | null;
  isRssAutoSyncing: boolean;
  onRssFeedConfigChange: (next: LocalRssFeedConfig | null) => void;
  onOpenBriefing: (briefing: AudioBriefing) => void;
  onDeleteBriefing: (id: string) => void;
  onGoToArticles: () => void;
}

export function ArchiveView({
  archive,
  activeBriefingId,
  playbackPositions,
  rssFeedConfig,
  isRssAutoSyncing,
  onRssFeedConfigChange,
  onOpenBriefing,
  onDeleteBriefing,
  onGoToArticles,
}: ArchiveViewProps) {
  const [rssModalOpen, setRssModalOpen] = useState(false);

  return (
    <div className="max-w-[1000px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
      <div className="pb-5 border-b border-[#22D3EE]/35 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-medium text-[#F5F7FA]">
            Briefing Archive
          </h1>
          <p className="mt-1 text-sm text-[#A0AABB]">
            Previously generated commute editions and automatically saved listening positions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-[#6E788A] tabular-nums">
            {archive.length} saved {archive.length === 1 ? 'edition' : 'editions'}
          </span>
          <button
            type="button"
            onClick={() => setRssModalOpen(true)}
            className="h-9 px-3.5 inline-flex items-center gap-2 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/45 hover:border-[#22D3EE] hover:text-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer"
          >
            {isRssAutoSyncing ? (
              <Loader2 className="w-3.5 h-3.5 text-[#22D3EE] animate-spin" aria-hidden="true" />
            ) : (
              <Rss className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            )}
            <span>{rssFeedConfig ? 'Private RSS Feed' : 'Export as RSS'}</span>
          </button>
        </div>
      </div>

      {/* Weekly Listening & Processed Articles Summary Dashboard (D3 Line Chart) */}
      <ArchiveSummaryDashboard archive={archive} />

      {archive.length === 0 ? (
        <div className="mt-8 p-10 text-center bg-[#13161C] border border-[#22D3EE]/30 rounded-lg">
          <p className="font-serif text-xl text-[#F5F7FA]">No archived editions yet</p>
          <p className="mt-2 text-sm text-[#A0AABB] max-w-md mx-auto">
            Each briefing you generate is automatically catalogued here so you can reopen cited scripts or resume listening right where you paused.
          </p>
          <button
            type="button"
            onClick={onGoToArticles}
            className="mt-6 h-10 px-5 text-sm font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
          >
            Create First Briefing
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-[#1E232D]">
          {archive.map((item) => {
            const isCurrent = item.id === activeBriefingId;
            const savedPos = playbackPositions[item.id];
            const hasResumePoint = Boolean(
              savedPos && (savedPos.segmentIndex > 0 || savedPos.currentTime >= 2)
            );
            const totalSeconds = item.segments.reduce(
              (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
              0
            );
            const dateLabel = new Intl.DateTimeFormat('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }).format(new Date(item.createdAt));

            return (
              <li
                key={item.id}
                className="py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#6E788A]">
                    <span className="font-mono tabular-nums">{dateLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-[#67E8F9]">
                      {item.preferences.format === 'podcast'
                        ? item.preferences.dynamicPanel
                          ? 'Dynamic Newsroom Panel'
                          : 'Two-Host Podcast'
                        : 'Solo Anchor'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {item.segments.length} chapters · {formatClock(totalSeconds)}
                    </span>
                    {hasResumePoint && savedPos && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[#22D3EE] font-medium tabular-nums">
                          Paused at Ch. {savedPos.segmentIndex + 1} ({formatClock(savedPos.currentTime)})
                        </span>
                      </>
                    )}
                    {isCurrent && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#F5F7FA] font-medium">Active</span>
                      </>
                    )}
                  </div>

                  <h2 className="mt-1.5 font-serif text-xl font-medium text-[#F5F7FA]">
                    {item.editionTitle}
                  </h2>

                  <p className="mt-1 text-sm text-[#A0AABB] line-clamp-2 max-w-2xl">
                    {item.editionSubtitle}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onOpenBriefing(item)}
                    className={`h-9 px-4 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      hasResumePoint
                        ? 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9]'
                        : 'text-[#F5F7FA] bg-[#171C24] border border-[#22D3EE]/40 hover:border-[#22D3EE] hover:text-[#67E8F9]'
                    }`}
                  >
                    <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
                    {hasResumePoint ? 'Resume Edition' : 'Open Edition'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete "${item.editionTitle}"`}
                    onClick={() => onDeleteBriefing(item.id)}
                    className="h-9 w-9 inline-flex items-center justify-center text-[#6E788A] hover:text-[#FCA5A5] bg-[#13161C] border border-[#222833] hover:border-[#F87171]/45 rounded-md transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <PrivateRssFeedModal
        isOpen={rssModalOpen}
        onClose={() => setRssModalOpen(false)}
        archive={archive}
        feedConfig={rssFeedConfig}
        onFeedConfigChange={onRssFeedConfigChange}
      />
    </div>
  );
}
