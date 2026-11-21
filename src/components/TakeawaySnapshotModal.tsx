import { useEffect, useRef, useState } from 'react';
import html2canvas from 'html2canvas-pro';
import {
  Check,
  Copy,
  Download,
  FileText,
  ListChecks,
  Loader2,
  X,
} from 'lucide-react';
import type { AudioBriefing } from '../types';
import { formatClock } from '../utils/wavUtils';
import { stripCitationMarkersForSpeech } from '../utils/passages';

type CardAspect = 'square' | 'wide' | 'portrait';
type CardTheme = 'charcoal-cyan' | 'graphite-ice';

interface TakeawaySnapshotModalProps {
  open: boolean;
  briefing: AudioBriefing;
  onClose: () => void;
  onSendToTasks?: () => void;
}

const ASPECT_OPTIONS: Array<{
  id: CardAspect;
  label: string;
  ratio: string;
  widthClass: string;
  minHeightClass: string;
}> = [
  {
    id: 'square',
    label: 'Square',
    ratio: '1:1',
    widthClass: 'w-[540px]',
    minHeightClass: 'min-h-[540px]',
  },
  {
    id: 'wide',
    label: 'Wide',
    ratio: '16:9',
    widthClass: 'w-[640px]',
    minHeightClass: 'min-h-[360px]',
  },
  {
    id: 'portrait',
    label: 'Portrait',
    ratio: '4:5',
    widthClass: 'w-[480px]',
    minHeightClass: 'min-h-[600px]',
  },
];

const THEME_CONFIG: Record<
  CardTheme,
  {
    label: string;
    outerBg: string;
    cardBg: string;
    rimColor: string;
    dividerColor: string;
    accentColor: string;
    mutedColor: string;
    titleColor: string;
    bodyColor: string;
    indexBg: string;
  }
> = {
  'charcoal-cyan': {
    label: 'Matte Charcoal',
    outerBg: '#0B0D10',
    cardBg: '#11151C',
    rimColor: 'rgba(34, 211, 238, 0.55)',
    dividerColor: 'rgba(34, 211, 238, 0.28)',
    accentColor: '#22D3EE',
    mutedColor: '#8E99AC',
    titleColor: '#F5F7FA',
    bodyColor: '#E4E9F1',
    indexBg: 'rgba(34, 211, 238, 0.12)',
  },
  'graphite-ice': {
    label: 'Deep Graphite',
    outerBg: '#0E1217',
    cardBg: '#161B23',
    rimColor: 'rgba(103, 232, 249, 0.5)',
    dividerColor: 'rgba(148, 163, 184, 0.26)',
    accentColor: '#67E8F9',
    mutedColor: '#98A4B8',
    titleColor: '#FFFFFF',
    bodyColor: '#E9EEF5',
    indexBg: 'rgba(103, 232, 249, 0.12)',
  },
};

export function TakeawaySnapshotModal({
  open,
  briefing,
  onClose,
  onSendToTasks,
}: TakeawaySnapshotModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [aspect, setAspect] = useState<CardAspect>('square');
  const [theme, setTheme] = useState<CardTheme>('charcoal-cyan');
  const [cleanText, setCleanText] = useState(true);
  const [showMeta, setShowMeta] = useState(true);

  const [isRendering, setIsRendering] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'text-copied'>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRendering) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, isRendering, onClose]);

  if (!open) return null;

  const activeAspect =
    ASPECT_OPTIONS.find((a) => a.id === aspect) ?? ASPECT_OPTIONS[0];
  const palette = THEME_CONFIG[theme];

  const totalSeconds = briefing.segments.reduce(
    (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
    0
  );

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(briefing.createdAt));

  const displayTakeaways = briefing.takeaways.map((point) =>
    cleanText ? stripCitationMarkersForSpeech(point) : point
  );

  const formatLabel =
    briefing.preferences.format === 'podcast'
      ? briefing.preferences.dynamicPanel
        ? 'Dynamic Newsroom Panel'
        : 'Two-Host Podcast'
      : 'Solo Anchor';

  async function renderCardBlob(): Promise<Blob> {
    const node = cardRef.current;
    if (!node) {
      throw new Error('Snapshot card is not ready yet.');
    }

    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    const canvas = await html2canvas(node, {
      scale: 2,
      useCORS: true,
      backgroundColor: palette.outerBg,
      logging: false,
    });

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Could not encode PNG snapshot.'));
          }
        },
        'image/png',
        1
      );
    });
  }

  async function handleCopyImage() {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsRendering(true);

    try {
      const supportsImageClipboard =
        typeof navigator !== 'undefined' &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== 'undefined';

      if (!supportsImageClipboard) {
        throw new Error('CLIPBOARD_UNSUPPORTED');
      }

      // Pass Promise<Blob> directly to ClipboardItem so browsers preserve the user-gesture window
      const blobPromise = renderCardBlob();
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blobPromise }),
        ]);
      } catch {
        // Fallback for browsers that require a resolved Blob instead of Promise<Blob>
        const resolvedBlob = await blobPromise;
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': resolvedBlob }),
        ]);
      }

      setCopyState('copied');
      setStatusMessage('PNG snapshot copied to clipboard — ready to paste anywhere.');
      setTimeout(() => setCopyState('idle'), 2600);
    } catch (err) {
      const isUnsupported =
        err instanceof Error && err.message === 'CLIPBOARD_UNSUPPORTED';
      setErrorMessage(
        isUnsupported
          ? 'Your browser does not support copying images directly. Use Download PNG below instead.'
          : 'Direct image copy was blocked by browser permissions in this window. Use Download PNG below to save the high-resolution card.'
      );
    } finally {
      setIsRendering(false);
    }
  }

  async function handleDownloadPng() {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsRendering(true);

    try {
      const blob = await renderCardBlob();
      const safeSlug = briefing.editionTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 44);

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dispatch-takeaways-${safeSlug || 'briefing'}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setStatusMessage('High-resolution PNG card downloaded.');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to render PNG snapshot.'
      );
    } finally {
      setIsRendering(false);
    }
  }

  async function handleCopyPlainText() {
    setErrorMessage(null);
    setStatusMessage(null);
    const lines = [
      briefing.editionTitle,
      `Dispatch Briefing · ${formattedDate}`,
      '',
      ...displayTakeaways.map((t, i) => `${i + 1}. ${t}`),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(lines);
      setCopyState('text-copied');
      setStatusMessage('Takeaways copied as plain text.');
      setTimeout(() => setCopyState('idle'), 2400);
    } catch {
      setErrorMessage('Could not access clipboard for text copy.');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share takeaway snapshot card"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        onClick={isRendering ? undefined : onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/80 backdrop-blur-xs"
      />

      {/* Modal Container */}
      <div className="relative z-10 w-full max-w-4xl max-h-[92vh] bg-[#11141A] border border-[#22D3EE]/45 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Share Takeaway Snapshot
            </h2>
            <p className="text-xs text-[#A0AABB] mt-0.5">
              Render a crisp 2x social card from your edition takeaways and copy straight to your clipboard.
            </p>
          </div>
          <button
            type="button"
            disabled={isRendering}
            onClick={onClose}
            aria-label="Close snapshot studio"
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1C222D] disabled:opacity-40 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Controls Bar */}
        <div className="px-6 py-3.5 bg-[#0E1116] border-b border-[#1E232D] flex flex-wrap items-center justify-between gap-4 shrink-0">
          <div className="flex flex-wrap items-center gap-4">
            {/* Aspect Ratio Selector */}
            <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
              {ASPECT_OPTIONS.map((opt) => {
                const active = opt.id === aspect;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAspect(opt.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    {opt.label}{' '}
                    <span className="font-mono text-[10px] opacity-75">
                      {opt.ratio}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Theme Selector */}
            <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
              {(Object.keys(THEME_CONFIG) as CardTheme[]).map((key) => {
                const active = key === theme;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTheme(key)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    {THEME_CONFIG[key].label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-[#A0AABB]">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cleanText}
                onChange={(e) => setCleanText(e.target.checked)}
                className="accent-[#22D3EE] w-3.5 h-3.5 rounded cursor-pointer"
              />
              Clean social text
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showMeta}
                onChange={(e) => setShowMeta(e.target.checked)}
                className="accent-[#22D3EE] w-3.5 h-3.5 rounded cursor-pointer"
              />
              Edition footer
            </label>
          </div>
        </div>

        {/* Preview Stage */}
        <div className="flex-1 overflow-auto p-6 sm:p-8 bg-[#080A0D] flex items-start sm:items-center justify-center">
          <div className="overflow-x-auto max-w-full py-1">
            {/* Capture Target — explicit hex/rgba values for crisp 2x canvas export */}
            <div
              ref={cardRef}
              className={`${activeAspect.widthClass} ${activeAspect.minHeightClass} mx-auto p-6 flex flex-col justify-between`}
              style={{
                backgroundColor: palette.outerBg,
              }}
            >
              <div
                className="flex-1 rounded-md p-7 flex flex-col justify-between relative"
                style={{
                  backgroundColor: palette.cardBg,
                  border: `1px solid ${palette.rimColor}`,
                }}
              >
                {/* Top Masthead Bar */}
                <div>
                  <div
                    className="flex items-center justify-between gap-4 pb-4"
                    style={{
                      borderBottom: `1px solid ${palette.dividerColor}`,
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="font-serif text-lg font-semibold tracking-tight"
                        style={{ color: palette.titleColor }}
                      >
                        Dispatch
                      </span>
                      <span
                        className="font-mono text-[10px] tracking-widest uppercase"
                        style={{ color: palette.accentColor }}
                      >
                        Key Takeaways
                      </span>
                    </div>
                    <span
                      className="font-mono text-[11px] tabular-nums"
                      style={{ color: palette.mutedColor }}
                    >
                      {formattedDate}
                    </span>
                  </div>

                  {/* Edition Headline */}
                  <div className="mt-5">
                    <h3
                      className="font-serif text-2xl font-medium leading-snug"
                      style={{ color: palette.titleColor }}
                    >
                      {briefing.editionTitle}
                    </h3>
                    {briefing.editionSubtitle && aspect !== 'wide' && (
                      <p
                        className="mt-1.5 text-xs leading-relaxed"
                        style={{ color: palette.mutedColor }}
                      >
                        {briefing.editionSubtitle}
                      </p>
                    )}
                  </div>

                  {/* Takeaways List */}
                  <ol
                    className={`mt-5 ${
                      aspect === 'wide' ? 'space-y-3' : 'space-y-4'
                    }`}
                  >
                    {displayTakeaways.map((point, idx) => (
                      <li key={idx} className="flex items-start gap-3">
                        <span
                          className="font-mono text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                          style={{
                            color: palette.accentColor,
                            backgroundColor: palette.indexBg,
                            border: `1px solid ${palette.dividerColor}`,
                          }}
                        >
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span
                          className="text-[13.5px] leading-relaxed"
                          style={{ color: palette.bodyColor }}
                        >
                          {point}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Editorial Footer */}
                {showMeta && (
                  <div
                    className="mt-6 pt-3.5 flex items-center justify-between gap-4 font-mono text-[11px] tabular-nums"
                    style={{
                      borderTop: `1px solid ${palette.dividerColor}`,
                      color: palette.mutedColor,
                    }}
                  >
                    <span>
                      {formatLabel} · {formatClock(totalSeconds)}
                    </span>
                    <span style={{ color: palette.accentColor }}>
                      {briefing.articleTitles.length}{' '}
                      {briefing.articleTitles.length === 1 ? 'source' : 'sources'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Status / Feedback Banner */}
        {(statusMessage || errorMessage) && (
          <div className="px-6 pt-3 bg-[#11141A] shrink-0">
            {statusMessage && (
              <p
                role="status"
                className="text-xs text-[#67E8F9] bg-[#0E2229] border border-[#22D3EE]/40 rounded-md px-3.5 py-2"
              >
                {statusMessage}
              </p>
            )}
            {errorMessage && (
              <p
                role="alert"
                className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3.5 py-2"
              >
                {errorMessage}
              </p>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-[#11141A] border-t border-[#222833] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            disabled={isRendering}
            onClick={handleCopyPlainText}
            className="h-10 px-3.5 inline-flex items-center gap-2 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#161B23] border border-[#273040] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45"
          >
            {copyState === 'text-copied' ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Text Copied
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Copy Text
              </>
            )}
          </button>

          <div className="flex flex-wrap items-center gap-2.5">
            {onSendToTasks && (
              <button
                type="button"
                disabled={isRendering}
                onClick={onSendToTasks}
                className="h-10 px-4 inline-flex items-center gap-2 text-xs sm:text-sm font-medium text-[#E4E9F1] hover:text-[#67E8F9] bg-[#161B23] border border-[#273040] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
              >
                <ListChecks className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                Send to Google Tasks
              </button>
            )}

            <button
              type="button"
              disabled={isRendering}
              onClick={handleDownloadPng}
              className="h-10 px-4 inline-flex items-center gap-2 text-sm font-medium text-[#F5F7FA] bg-[#161B23] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45"
            >
              <Download className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              Download PNG
            </button>

            <button
              type="button"
              disabled={isRendering}
              onClick={handleCopyImage}
              className="h-10 px-5 inline-flex items-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45"
            >
              {isRendering ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  Rendering PNG...
                </>
              ) : copyState === 'copied' ? (
                <>
                  <Check className="w-4 h-4" aria-hidden="true" />
                  Copied to Clipboard
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" aria-hidden="true" />
                  Copy Image to Clipboard
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
