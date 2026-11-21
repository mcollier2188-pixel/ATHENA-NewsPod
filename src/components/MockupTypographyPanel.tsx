import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  Globe,
  Loader2,
  RotateCcw,
  Sparkles,
  Type,
} from 'lucide-react';
import type {
  MockupFontMood,
  MockupFontPairing,
  SiteMockupProject,
} from '../types';
import {
  buildFontStack,
  buildMockupFontCssVars,
  CURATED_FONT_PAIRINGS,
  ensureGoogleFontsLoaded,
  POPULAR_BODY_FONTS,
  POPULAR_HEADING_FONTS,
  resolveActiveFontPairing,
} from '../utils/googleFonts';

interface MockupTypographyPanelProps {
  project: SiteMockupProject;
  urlInput: string;
  onUrlInputChange: (nextUrl: string) => void;
  detectedSiteFonts: string[];
  isSuggestingFonts: boolean;
  fontSuggestError: string | null;
  appliedPairingFeedback: {
    id: string;
    name: string;
    seq: number;
  } | null;
  onSuggestFonts: (overrideUrl?: string) => void;
  onApplyPairing: (pairing: MockupFontPairing) => void;
  onSelectCustomFont: (
    slot: 'heading' | 'body',
    family: string,
    category: 'sans-serif' | 'serif' | 'display'
  ) => void;
  onSelectMood: (mood: MockupFontMood) => void;
  onResetTypography: () => void;
}

function isSameFontPairing(a: MockupFontPairing, b: MockupFontPairing): boolean {
  return (
    a.headingFont.trim().toLowerCase() === b.headingFont.trim().toLowerCase() &&
    a.bodyFont.trim().toLowerCase() === b.bodyFont.trim().toLowerCase()
  );
}

export function MockupTypographyPanel({
  project,
  urlInput,
  onUrlInputChange,
  detectedSiteFonts,
  isSuggestingFonts,
  fontSuggestError,
  appliedPairingFeedback,
  onSuggestFonts,
  onApplyPairing,
  onSelectCustomFont,
  onSelectMood,
  onResetTypography,
}: MockupTypographyPanelProps) {
  const [copiedCss, setCopiedCss] = useState(false);
  const copiedCssTimerRef = useRef<number | null>(null);

  const activePairing = resolveActiveFontPairing(
    project.brand.fontMood,
    project.brand.fontPairing
  );
  const activeVars = buildMockupFontCssVars(activePairing);
  const suggestedPairings = project.suggestedFontPairings || [];

  // Load Google Fonts dynamically for the active pairing, suggested pairings, and curated library
  useEffect(() => {
    const families: string[] = [
      activePairing.headingFont,
      activePairing.bodyFont,
      activePairing.monoFont || 'IBM Plex Mono',
    ];
    for (const item of suggestedPairings) {
      families.push(item.headingFont, item.bodyFont);
      if (item.monoFont) families.push(item.monoFont);
    }
    for (const item of CURATED_FONT_PAIRINGS) {
      families.push(item.headingFont, item.bodyFont);
      if (item.monoFont) families.push(item.monoFont);
    }
    ensureGoogleFontsLoaded(families);
  }, [activePairing, suggestedPairings]);

  useEffect(() => {
    return () => {
      if (copiedCssTimerRef.current) {
        window.clearTimeout(copiedCssTimerRef.current);
      }
    };
  }, []);

  // Combine suggested fonts + popular heading/body fonts for custom pickers
  const headingOptions = useMemo(() => {
    const map = new Map<string, 'sans-serif' | 'serif' | 'display'>();
    map.set(activePairing.headingFont, activePairing.headingCategory);
    for (const item of suggestedPairings) {
      if (!map.has(item.headingFont)) {
        map.set(item.headingFont, item.headingCategory);
      }
    }
    for (const item of POPULAR_HEADING_FONTS) {
      if (!map.has(item.family)) {
        map.set(item.family, item.category);
      }
    }
    return Array.from(map.entries()).map(([family, category]) => ({
      family,
      category,
    }));
  }, [activePairing.headingCategory, activePairing.headingFont, suggestedPairings]);

  const bodyOptions = useMemo(() => {
    const map = new Map<string, 'sans-serif' | 'serif'>();
    map.set(activePairing.bodyFont, activePairing.bodyCategory);
    for (const item of suggestedPairings) {
      if (!map.has(item.bodyFont)) {
        map.set(item.bodyFont, item.bodyCategory);
      }
    }
    for (const item of POPULAR_BODY_FONTS) {
      if (!map.has(item.family)) {
        map.set(item.family, item.category);
      }
    }
    return Array.from(map.entries()).map(([family, category]) => ({
      family,
      category,
    }));
  }, [activePairing.bodyCategory, activePairing.bodyFont, suggestedPairings]);

  async function handleCopyCssVariables() {
    const cssSnippet = [
      ':root {',
      `  --mockup-font-heading: ${activeVars.headingStack};`,
      `  --mockup-font-body: ${activeVars.bodyStack};`,
      `  --mockup-font-mono: ${activeVars.monoStack};`,
      '}',
    ].join('\n');

    try {
      await navigator.clipboard.writeText(cssSnippet);
      if (copiedCssTimerRef.current) window.clearTimeout(copiedCssTimerRef.current);
      setCopiedCss(true);
      copiedCssTimerRef.current = window.setTimeout(() => {
        setCopiedCss(false);
      }, 1800);
    } catch {
      // Clipboard unavailable
    }
  }

  function handleUrlSubmit(e: FormEvent) {
    e.preventDefault();
    onSuggestFonts(urlInput);
  }

  const effectiveTargetUrl = (urlInput || project.sourceUrl || '').trim();

  function renderPairingCard(pairing: MockupFontPairing, isAiSuggested: boolean) {
    const isActive = isSameFontPairing(activePairing, pairing);
    const isJustApplied =
      appliedPairingFeedback?.id === pairing.id ||
      (appliedPairingFeedback &&
        isActive &&
        appliedPairingFeedback.name === pairing.name);

    const headingStack = buildFontStack(pairing.headingFont, pairing.headingCategory);
    const bodyStack = buildFontStack(pairing.bodyFont, pairing.bodyCategory);

    return (
      <button
        key={pairing.id}
        type="button"
        aria-pressed={isActive}
        onClick={() => onApplyPairing(pairing)}
        className={`group swatch-interactive w-full text-left rounded-md border p-3 transition-all cursor-pointer ${
          isJustApplied
            ? 'bg-[#121D27] border-[#22D3EE] swatch-apply-pulse'
            : isActive
              ? 'bg-[#121D27] border-[#22D3EE] shadow-[0_0_0_1px_rgba(34,211,238,0.2)]'
              : 'bg-[#0B0D10] border-[#222833] hover:border-[#22D3EE]/65 hover:bg-[#11161E]'
        }`}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0">
            <p
              className={`text-xs font-semibold truncate transition-colors ${
                isActive ? 'text-[#67E8F9]' : 'text-[#F5F7FA] group-hover:text-[#67E8F9]'
              }`}
            >
              {pairing.name}
            </p>
            <p className="font-mono text-[10px] text-[#8C96A8] truncate mt-0.5">
              {pairing.headingFont} + {pairing.bodyFont}
            </p>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap ${
              isJustApplied
                ? 'text-[#34D399]'
                : isActive
                  ? 'text-[#67E8F9]'
                  : 'text-[#8C96A8] group-hover:text-[#67E8F9]'
            }`}
          >
            {isJustApplied ? (
              <>
                <Check className="w-3 h-3 text-[#34D399]" aria-hidden="true" />
                Applied
              </>
            ) : isActive ? (
              <>
                <Check className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                Active
              </>
            ) : (
              'Apply'
            )}
          </span>
        </div>

        {/* Live Google Font Specimen Preview */}
        <div className="rounded bg-[#11151D] border border-[#1E2430] px-2.5 py-2 space-y-1">
          <p
            className="text-[15px] font-bold leading-snug text-[#F5F7FA] truncate"
            style={{ fontFamily: headingStack }}
          >
            {project.brand.name || 'Built to Last Across Every Site'}
          </p>
          <p
            className="text-[11px] leading-relaxed text-[#A8B2C4] line-clamp-2"
            style={{ fontFamily: bodyStack }}
          >
            {pairing.rationale}
          </p>
        </div>

        {/* Metadata row — plain hairline text, zero decorative pills */}
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] font-mono text-[#6E788A]">
          <span className="truncate">
            {isAiSuggested && pairing.sourceNote
              ? pairing.sourceNote
              : `${pairing.headingCategory} / ${pairing.bodyCategory}`}
          </span>
          <span className="uppercase tracking-wider shrink-0">
            {pairing.mood}
          </span>
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-5">
      {/* 1. Active Typography Specimen & Live CSS Variables */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F5F7FA]">
            <Type className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Active Typography
          </span>
          <div className="flex items-center gap-2">
            {project.brand.fontPairing && (
              <button
                type="button"
                onClick={onResetTypography}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8C96A8] hover:text-[#F5F7FA] transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                Default
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyCssVariables}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] hover:text-[#A5F3FC] transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedCss ? (
                <>
                  <Check className="w-3 h-3 text-[#34D399]" aria-hidden="true" />
                  <span className="text-[#34D399]">Copied CSS</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" aria-hidden="true" />
                  Copy CSS
                </>
              )}
            </button>
          </div>
        </div>

        <div className="rounded-md bg-[#0B0D10] border border-[#22D3EE]/35 p-3 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-[#67E8F9] truncate">
              {activePairing.name}
            </span>
            <span className="font-mono text-[10px] text-[#8C96A8] uppercase tracking-wider shrink-0">
              {activePairing.mood}
            </span>
          </div>

          <div className="rounded bg-[#11151D] border border-[#1E2430] px-3 py-2.5 space-y-1">
            <p
              className="text-lg font-bold leading-tight text-[#F5F7FA] truncate"
              style={{ fontFamily: activeVars.headingStack }}
            >
              Aa Bb — {activePairing.headingFont}
            </p>
            <p
              className="text-xs leading-relaxed text-[#A8B2C4]"
              style={{ fontFamily: activeVars.bodyStack }}
            >
              Body copy in {activePairing.bodyFont} for clear quotes, services, and trust metrics.
            </p>
          </div>

          {/* Live CSS Variables readout */}
          <div className="space-y-1 pt-1 border-t border-[#1B212D] font-mono text-[10px] leading-relaxed">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6E788A] shrink-0">--mockup-font-heading</span>
              <span className="text-[#D5DCE6] truncate" title={activeVars.headingStack}>
                &quot;{activePairing.headingFont}&quot;
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6E788A] shrink-0">--mockup-font-body</span>
              <span className="text-[#D5DCE6] truncate" title={activeVars.bodyStack}>
                &quot;{activePairing.bodyFont}&quot;
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6E788A] shrink-0">--mockup-font-mono</span>
              <span className="text-[#D5DCE6] truncate" title={activeVars.monoStack}>
                &quot;{activePairing.monoFont || 'IBM Plex Mono'}&quot;
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. URL-Based Google Font Pairing Suggester */}
      <div className="pt-4 border-t border-[#1F2532] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F5F7FA]">
            <Sparkles className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Suggest from Website URL
          </span>
          {appliedPairingFeedback && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#34D399]"
            >
              <Check className="w-3 h-3" aria-hidden="true" />
              Applied
            </span>
          )}
        </div>

        <form onSubmit={handleUrlSubmit} className="space-y-2">
          <div className="relative">
            <Globe
              className="w-3.5 h-3.5 text-[#6E788A] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="typography-url-input" className="sr-only">
              Website URL for Google Font suggestions
            </label>
            <input
              id="typography-url-input"
              type="text"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              placeholder={project.sourceUrl || 'e.g. hiscompany.co.uk'}
              disabled={isSuggestingFonts}
              className="w-full h-9 pl-8 pr-3 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md placeholder:text-[#6E788A]"
            />
          </div>

          <button
            type="submit"
            disabled={isSuggestingFonts || !effectiveTargetUrl}
            className="w-full h-9 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
          >
            {isSuggestingFonts ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Inspecting Site Typography...
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                Suggest Google Font Pairings
              </>
            )}
          </button>
        </form>

        {fontSuggestError && (
          <p role="alert" className="text-[11px] text-[#FCA5A5] leading-relaxed">
            {fontSuggestError}
          </p>
        )}

        {detectedSiteFonts.length > 0 && (
          <div className="rounded-md bg-[#0B0D10] border border-[#1F2532] px-2.5 py-2 space-y-1">
            <span className="block font-mono text-[10px] uppercase tracking-wider text-[#6E788A]">
              Detected on Source Site
            </span>
            <p className="text-[11px] text-[#D5DCE6] font-mono leading-relaxed">
              {detectedSiteFonts.join(' · ')}
            </p>
          </div>
        )}

        {suggestedPairings.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[#8C96A8]">
                Suggested for URL ({suggestedPairings.length})
              </span>
              <span className="text-[10px] text-[#6E788A]">
                1-click apply
              </span>
            </div>
            <div className="space-y-2">
              {suggestedPairings.map((pairing) => renderPairingCard(pairing, true))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-[#8C96A8] leading-relaxed bg-[#0B0D10] border border-[#1F2532] rounded-md px-2.5 py-2">
            Enter a website URL and click{' '}
            <strong className="text-[#D5DCE6]">Suggest Google Font Pairings</strong> to inspect
            its typography and generate 4 tailored pairings. Click any pairing to update every
            mockup heading and body element instantly.
          </p>
        )}
      </div>

      {/* 3. Custom Font Override Pickers & Mood */}
      <div className="pt-4 border-t border-[#1F2532] space-y-3">
        <span className="block text-xs font-semibold text-[#F5F7FA]">
          Custom Font Override
        </span>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label
              htmlFor="mockup-heading-font-select"
              className="block text-[11px] font-medium text-[#8C96A8] mb-1"
            >
              Heading Font
            </label>
            <select
              id="mockup-heading-font-select"
              value={activePairing.headingFont}
              onChange={(e) => {
                const chosen = headingOptions.find((o) => o.family === e.target.value);
                onSelectCustomFont(
                  'heading',
                  e.target.value,
                  chosen?.category || 'sans-serif'
                );
              }}
              className="w-full h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md cursor-pointer"
            >
              {headingOptions.map((opt) => (
                <option key={opt.family} value={opt.family}>
                  {opt.family}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="mockup-body-font-select"
              className="block text-[11px] font-medium text-[#8C96A8] mb-1"
            >
              Body Font
            </label>
            <select
              id="mockup-body-font-select"
              value={activePairing.bodyFont}
              onChange={(e) => {
                const chosen = bodyOptions.find((o) => o.family === e.target.value);
                onSelectCustomFont(
                  'body',
                  e.target.value,
                  chosen?.category || 'sans-serif'
                );
              }}
              className="w-full h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md cursor-pointer"
            >
              {bodyOptions.map((opt) => (
                <option key={opt.family} value={opt.family}>
                  {opt.family}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Typographic Rhythm / Mood */}
        <div>
          <span className="block text-[11px] font-medium text-[#8C96A8] mb-1.5">
            Typographic Rhythm
          </span>
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0D10] border border-[#222833] rounded-md">
            {(
              [
                { id: 'industrial', label: 'Industrial' },
                { id: 'modern', label: 'Modern' },
                { id: 'editorial', label: 'Editorial' },
              ] as Array<{ id: MockupFontMood; label: string }>
            ).map((mood) => (
              <button
                key={mood.id}
                type="button"
                onClick={() => onSelectMood(mood.id)}
                className={`py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  project.brand.fontMood === mood.id
                    ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                {mood.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 4. Curated Google Font Pairings Library */}
      <div className="pt-4 border-t border-[#1F2532] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[#F5F7FA]">
            Curated Google Font Pairings
          </span>
          <span className="font-mono text-[10px] text-[#6E788A] tabular-nums">
            {CURATED_FONT_PAIRINGS.length} presets
          </span>
        </div>
        <div className="space-y-2">
          {CURATED_FONT_PAIRINGS.map((pairing) => renderPairingCard(pairing, false))}
        </div>
      </div>
    </div>
  );
}
