import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileDown, Loader2, Printer, X } from 'lucide-react';
import type { SiteMockupProject } from '../types';
import {
  autoFixMockupPalette,
  evaluateMockupContrast,
  formatContrastRatio,
  normalizeHex,
  resolvePaletteTextColors,
} from '../utils/colorContrast';
import {
  buildMockupFontCssVars,
  ensureGoogleFontsLoaded,
  resolveActiveFontPairing,
} from '../utils/googleFonts';
import { collectProjectAssets } from '../utils/mockupAssetZip';
import {
  exportElementToSinglePagePdf,
  type PitchPdfExportResult,
  type PitchPdfPageFormat,
} from '../utils/pitchPdfExport';

interface MockupPitchSheetModalProps {
  isOpen: boolean;
  project: SiteMockupProject;
  onClose: () => void;
  onExportSuccess?: (result: PitchPdfExportResult) => void;
}

export function MockupPitchSheetModal({
  isOpen,
  project,
  onClose,
  onExportSuccess,
}: MockupPitchSheetModalProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const [pageFormat, setPageFormat] = useState<PitchPdfPageFormat>('a4');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExportResult, setLastExportResult] =
    useState<PitchPdfExportResult | null>(null);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [render3dLoadFailed, setRender3dLoadFailed] = useState(false);

  const { brand, hero, services, projects, about, siteNotes, brandSwatches } =
    project;

  const saved3DRender = useMemo(
    () =>
      (project.mediaCollection || []).find(
        (asset) =>
          asset.id.startsWith('render3d-') || asset.label.startsWith('3D Stage:')
      ) || null,
    [project.mediaCollection]
  );

  const activePairing = useMemo(
    () => resolveActiveFontPairing(brand.fontMood, brand.fontPairing),
    [brand.fontMood, brand.fontPairing]
  );

  const fontVars = useMemo(
    () => buildMockupFontCssVars(activePairing),
    [activePairing]
  );

  useEffect(() => {
    setLogoLoadFailed(false);
  }, [brand.logoDataUrl]);

  useEffect(() => {
    setRender3dLoadFailed(false);
  }, [saved3DRender?.dataUrl]);

  useEffect(() => {
    if (!isOpen) return;
    ensureGoogleFontsLoaded([
      activePairing.headingFont,
      activePairing.bodyFont,
      activePairing.monoFont || 'IBM Plex Mono',
    ]);
  }, [
    isOpen,
    activePairing.headingFont,
    activePairing.bodyFont,
    activePairing.monoFont,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExportingPdf) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isExportingPdf, onClose]);

  const resolvedColors = useMemo(
    () => resolvePaletteTextColors(brand.palette),
    [brand.palette]
  );

  const paperReadablePalette = useMemo(
    () =>
      autoFixMockupPalette(
        resolvedColors.primary,
        resolvedColors.accent,
        'light',
        brand.palette
      ),
    [resolvedColors.primary, resolvedColors.accent, brand.palette]
  );

  const contrastAudit = useMemo(
    () =>
      evaluateMockupContrast(
        resolvedColors.primary,
        resolvedColors.accent,
        brand.palette.canvasMode,
        brand.palette
      ),
    [
      resolvedColors.primary,
      resolvedColors.accent,
      brand.palette,
    ]
  );

  const projectAssets = useMemo(() => collectProjectAssets(project), [project]);
  const totalAssetKb = useMemo(
    () => projectAssets.reduce((sum, item) => sum + (item.sizeKb || 0), 0),
    [projectAssets]
  );

  if (!isOpen) return null;

  const primary = normalizeHex(resolvedColors.primary, '#0F172A');
  const accent = normalizeHex(resolvedColors.accent, '#0284C7');
  const onPrimary = normalizeHex(resolvedColors.onPrimary, '#FFFFFF');
  const onAccent = normalizeHex(resolvedColors.onAccent, '#FFFFFF');
  const readableAccentOnWhite = normalizeHex(
    paperReadablePalette.accentText,
    '#0E7490'
  );

  const displaySwatches =
    brandSwatches && brandSwatches.length > 0
      ? brandSwatches.slice(0, 6).map((sw) => ({
          ...sw,
          hex: normalizeHex(sw.hex, primary),
        }))
      : [
          {
            hex: primary,
            name: 'Primary Brand',
            role: 'primary' as const,
            usageNote: 'Header & hero anchor',
          },
          {
            hex: accent,
            name: 'Action Accent',
            role: 'accent' as const,
            usageNote: 'Primary CTA & focus',
          },
          {
            hex: onPrimary,
            name: 'Ink on Primary',
            role: 'neutral' as const,
            usageNote: 'Headline contrast',
          },
          {
            hex: brand.palette.canvasMode === 'dark' ? '#161C26' : '#F8FAFC',
            name:
              brand.palette.canvasMode === 'dark'
                ? 'Dark Canvas'
                : 'Light Surface',
            role: 'surface' as const,
            usageNote: `${brand.palette.canvasMode} page field`,
          },
        ];

  const documentedMetricsCount = projects.filter(
    (prj) => Boolean(prj.metric && prj.metric.trim())
  ).length;
  const cleanCredentials = about.credentials.filter(Boolean);
  const cleanTrustHighlights = hero.trustHighlights.filter(Boolean);
  const totalTrustProofPoints =
    cleanCredentials.length + cleanTrustHighlights.length;

  const todayLabel = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const brandInitials =
    (brand.name || 'Client')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'CS';

  const scopedSheetCss = `
    #mockup-pitch-print-sheet {
      --pitch-primary: ${primary};
      --pitch-on-primary: ${onPrimary};
      --pitch-accent: ${accent};
      --pitch-on-accent: ${onAccent};
      --pitch-accent-readable: ${readableAccentOnWhite};
      --mockup-font-heading: ${fontVars.headingStack};
      --mockup-font-body: ${fontVars.bodyStack};
      --mockup-font-mono: ${fontVars.monoStack};
    }
  `;

  const handlePrintToPdf = async () => {
    if (!sheetRef.current || isExportingPdf) return;
    setIsExportingPdf(true);
    setExportError(null);
    try {
      const result = await exportElementToSinglePagePdf(sheetRef.current, {
        brandName: brand.name || 'Client',
        title: `${brand.name || 'Client'} — Single-Page Client Pitch Summary`,
        author: brand.name || 'SiteMockup Studio',
        pageFormat,
        pixelScale: 2,
      });
      setLastExportResult(result);
      onExportSuccess?.(result);
    } catch (err) {
      setExportError(
        err instanceof Error
          ? err.message
          : 'Unable to generate PDF file. Try Browser Print instead.'
      );
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 overflow-y-auto p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pitch-pdf-modal-title"
    >
      <style>{scopedSheetCss}</style>

      {/* Top Studio Control Bar (excluded from print & PDF capture) */}
      <div className="no-print max-w-[840px] w-full mx-auto mb-3 bg-[#13161C] border border-[#22D3EE]/40 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="pitch-pdf-modal-title"
            className="text-sm font-semibold text-[#F5F7FA] truncate"
          >
            Print to PDF — Single-Page Client Pitch Summary
          </h2>
          <p className="text-[11px] text-[#8C96A8] mt-0.5">
            {lastExportResult ? (
              <span className="text-[#67E8F9] font-mono tabular-nums">
                Saved {lastExportResult.filename} · {lastExportResult.sizeKb} KB ·
                Single-page {lastExportResult.pageFormat.toUpperCase()}
              </span>
            ) : (
              'Includes branding colors, typography specimens, service area coverage, and key project metrics'
            )}
          </p>
          {exportError && (
            <p role="alert" className="text-[11px] text-[#FCA5A5] mt-1">
              {exportError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Paper Size Selector */}
          <div
            role="group"
            aria-label="PDF paper format"
            className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#2A3342] rounded-md"
          >
            {(['a4', 'letter'] as PitchPdfPageFormat[]).map((fmt) => {
              const active = pageFormat === fmt;
              return (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setPageFormat(fmt)}
                  className={`h-8 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[#18212E] text-[#67E8F9]'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  {fmt === 'a4' ? 'A4' : 'US Letter'}
                </button>
              );
            })}
          </div>

          {/* Native Browser Print Dialog */}
          <button
            type="button"
            onClick={() => window.print()}
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0B0D10] hover:bg-[#18212E] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Browser Print
          </button>

          {/* Direct 1-Page PDF Download */}
          <button
            type="button"
            disabled={isExportingPdf}
            onClick={() => void handlePrintToPdf()}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isExportingPdf ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Generating PDF...
              </>
            ) : lastExportResult ? (
              <>
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                Download PDF Again
              </>
            ) : (
              <>
                <FileDown className="w-3.5 h-3.5" aria-hidden="true" />
                Save Single-Page PDF
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close client pitch summary"
            className="w-9 h-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Printable Single-Page Executive Sheet */}
      <article
        ref={sheetRef}
        id="mockup-pitch-print-sheet"
        className="max-w-[840px] w-full mx-auto bg-white text-slate-900 rounded-lg shadow-2xl border border-slate-200 overflow-hidden"
      >
        {/* Sheet Header Banner (SVG fill guarantees exact brand color in print & PDF) */}
        <header className="pitch-header-surface relative px-7 py-5 overflow-hidden">
          <svg
            aria-hidden="true"
            viewBox="0 0 840 120"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full pointer-events-none"
          >
            <rect width="840" height="120" fill={primary} />
          </svg>

          <div className="relative z-10 flex items-center justify-between gap-6">
            <div className="flex items-center gap-3.5 min-w-0">
              {brand.logoDataUrl && !logoLoadFailed ? (
                <img
                  src={brand.logoDataUrl}
                  alt={`${brand.name} logo`}
                  referrerPolicy="no-referrer"
                  onError={() => setLogoLoadFailed(true)}
                  className="h-11 w-auto max-w-[124px] object-contain bg-white/95 rounded px-2 py-1 shrink-0"
                />
              ) : (
                <div className="w-11 h-11 rounded bg-white/15 border border-white/25 flex items-center justify-center font-bold text-sm tracking-tight shrink-0 pitch-heading-specimen">
                  {brandInitials}
                </div>
              )}

              <div className="min-w-0">
                <p className="text-[11px] font-medium opacity-80">
                  Client Pitch Summary · {todayLabel}
                </p>
                <h1 className="text-xl font-bold leading-tight truncate pitch-heading-specimen">
                  {brand.name || 'Client Website Proposal'}
                </h1>
                <p className="text-xs opacity-90 truncate mt-0.5">
                  {brand.industry || 'Commercial & Local Services'}
                </p>
              </div>
            </div>

            <div className="text-right text-[11px] space-y-0.5 shrink-0 opacity-95">
              {project.sourceUrl && (
                <p className="font-mono truncate max-w-[230px]">
                  {project.sourceUrl}
                </p>
              )}
              {brand.phone && (
                <p className="font-mono tabular-nums">{brand.phone}</p>
              )}
              {brand.email && (
                <p className="truncate max-w-[230px]">{brand.email}</p>
              )}
            </div>
          </div>
        </header>

        {/* Dedicated Service Area & Operational Coverage Bar */}
        <div className="bg-slate-50 border-b border-slate-200 px-7 py-3 grid grid-cols-12 gap-4 text-xs">
          <div className="col-span-5 min-w-0">
            <p className="text-[10px] font-semibold text-slate-500">
              Service Area &amp; Coverage
            </p>
            <p className="font-semibold text-slate-900 truncate mt-0.5">
              {brand.serviceArea || 'Local & Regional Coverage'}
            </p>
          </div>

          <div className="col-span-4 min-w-0 border-l border-slate-200 pl-4">
            <p className="text-[10px] font-semibold text-slate-500">
              Location &amp; Operating Hours
            </p>
            <p className="text-slate-800 truncate mt-0.5">
              {[brand.address, brand.hours].filter(Boolean).join(' · ') ||
                'Direct dispatch & scheduled appointments'}
            </p>
          </div>

          <div className="col-span-3 min-w-0 border-l border-slate-200 pl-4">
            <p className="text-[10px] font-semibold text-slate-500">
              Primary Conversion Action
            </p>
            <p className="font-semibold pitch-accent-text truncate mt-0.5">
              {hero.primaryCta || 'Request a Free Quote'}
            </p>
          </div>
        </div>

        {/* Main Single-Page Pitch Body */}
        <div className="px-7 py-5 space-y-4 text-slate-800">
          {/* 01. Key Project Metrics & Portfolio Outcomes */}
          <section>
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <h2 className="text-xs font-semibold text-slate-900">
                01. Key Project Metrics &amp; Scope Readiness
              </h2>
              <p className="text-[11px] text-slate-500 tabular-nums">
                {services.length} services · {projects.length} case studies ·{' '}
                {documentedMetricsCount} verified outcome metrics
              </p>
            </div>

            {/* Quantitative KPI Summary Strip */}
            <div className="grid grid-cols-5 divide-x divide-slate-200 border-y border-slate-200 py-2.5 text-left">
              <div className="pr-3">
                <p className="text-[10px] text-slate-500">Core Services</p>
                <p className="text-base font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                  {services.length}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  Scoped offerings
                </p>
              </div>

              <div className="px-3">
                <p className="text-[10px] text-slate-500">Case Studies</p>
                <p className="text-base font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                  {projects.length}
                </p>
                <p className="text-[10px] text-slate-500 tabular-nums truncate">
                  {documentedMetricsCount} with KPI proof
                </p>
              </div>

              <div className="px-3">
                <p className="text-[10px] text-slate-500">WCAG AA Contrast</p>
                <p className="text-base font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                  {contrastAudit.passedCount}/{contrastAudit.totalCount}
                </p>
                <p className="text-[10px] text-slate-500 tabular-nums truncate">
                  {contrastAudit.allPassAA
                    ? '100% AA verified'
                    : `${contrastAudit.scorePercent}% compliant`}
                </p>
              </div>

              <div className="px-3">
                <p className="text-[10px] text-slate-500">Trust Signals</p>
                <p className="text-base font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                  {totalTrustProofPoints}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  Credentials &amp; badges
                </p>
              </div>

              <div className="pl-3">
                <p className="text-[10px] text-slate-500">Staged Media</p>
                <p className="text-base font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                  {projectAssets.length}
                </p>
                <p className="text-[10px] text-slate-500 tabular-nums truncate">
                  {totalAssetKb > 0
                    ? `~${totalAssetKb} KB ready`
                    : 'Copy & theme ready'}
                </p>
              </div>
            </div>

            {/* Featured Project Outcomes Table */}
            {projects.length > 0 && (
              <div className="mt-2.5">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-200 text-[10px] font-semibold text-slate-500">
                      <th className="py-1 pr-3 font-semibold w-[30%]">
                        Featured Project
                      </th>
                      <th className="py-1 px-2 font-semibold w-[20%]">
                        Location
                      </th>
                      <th className="py-1 px-2 font-semibold w-[22%]">
                        Key Metric / Outcome
                      </th>
                      <th className="py-1 pl-2 font-semibold w-[28%]">
                        Scope Summary
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {projects.slice(0, 3).map((prj) => (
                      <tr key={prj.id} className="align-top">
                        <td className="py-1.5 pr-3 font-semibold text-slate-900">
                          <span className="line-clamp-1">{prj.title}</span>
                        </td>
                        <td className="py-1.5 px-2 text-slate-600">
                          <span className="line-clamp-1">
                            {prj.location || brand.serviceArea || 'Local site'}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 font-mono font-semibold pitch-accent-text tabular-nums">
                          <span className="line-clamp-1">
                            {prj.metric || 'Verified completion'}
                          </span>
                        </td>
                        <td className="py-1.5 pl-2 text-slate-600">
                          <span className="line-clamp-1">{prj.summary}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 02. Branding Colors & Contrast System */}
          <section className="pt-3.5 border-t border-slate-200">
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <h2 className="text-xs font-semibold text-slate-900">
                02. Branding Colors &amp; Accessibility Contrast
              </h2>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                Canvas: {brand.palette.canvasMode} · Primary: {primary} · Accent:{' '}
                {accent}
              </p>
            </div>

            <div className="grid grid-cols-6 gap-2.5">
              {displaySwatches.map((sw, idx) => (
                <div key={`${sw.hex}-${idx}`} className="min-w-0">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 120 26"
                    preserveAspectRatio="none"
                    className="w-full h-6 rounded-sm border border-slate-200 block"
                  >
                    <rect width="120" height="26" fill={sw.hex} />
                  </svg>
                  <p className="text-[10px] font-semibold text-slate-900 truncate mt-1">
                    {sw.name}
                  </p>
                  <p className="font-mono text-[9px] text-slate-500 tabular-nums truncate">
                    {sw.hex} · {sw.role}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600 font-mono tabular-nums">
              {contrastAudit.checks.map((check) => (
                <span key={check.id}>
                  {check.label}:{' '}
                  <strong className="text-slate-900">
                    {formatContrastRatio(check.ratio)}
                  </strong>{' '}
                  ({check.passesAA ? 'AA Pass' : 'Review'})
                </span>
              ))}
            </div>
          </section>

          {/* 03. Typography System & Specimens */}
          <section className="pt-3.5 border-t border-slate-200">
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <h2 className="text-xs font-semibold text-slate-900">
                03. Typography System — {activePairing.name}
              </h2>
              <p className="text-[11px] text-slate-500">
                Mood: <span className="capitalize">{brand.fontMood}</span> · 2+1
                Type Hierarchy
              </p>
            </div>

            <div className="grid grid-cols-12 gap-5 border-y border-slate-200 py-2.5">
              {/* Heading Specimen */}
              <div className="col-span-6 pr-2 flex items-start gap-3">
                <span className="text-2xl font-bold text-slate-900 leading-none pitch-heading-specimen shrink-0 pt-0.5">
                  Aa
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-slate-900">
                    Heading — {activePairing.headingFont}{' '}
                    <span className="font-normal text-slate-500">
                      ({activePairing.headingCategory})
                    </span>
                  </p>
                  <p className="text-xs font-semibold text-slate-800 truncate mt-0.5 pitch-heading-specimen">
                    {hero.headline || `${brand.name} — Trusted Specialists`}
                  </p>
                  <p className="text-[10px] text-slate-500 line-clamp-1 mt-0.5">
                    {activePairing.rationale}
                  </p>
                </div>
              </div>

              {/* Body & Monospace Specimen */}
              <div className="col-span-6 border-l border-slate-200 pl-4 flex items-start gap-3">
                <span className="text-2xl font-normal text-slate-700 leading-none pitch-body-specimen shrink-0 pt-0.5">
                  Aa
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-slate-900">
                    Body — {activePairing.bodyFont}{' '}
                    <span className="font-normal text-slate-500">
                      ({activePairing.bodyCategory}) · Mono:{' '}
                      {activePairing.monoFont || 'IBM Plex Mono'}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-700 line-clamp-1 mt-0.5 pitch-body-specimen">
                    Clear, approachable service copy built for fast customer
                    decisions on mobile and desktop.
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5 pitch-mono-specimen tabular-nums">
                    Figures: 0123456789 · 24/7 Response · 4.9/5.0 Rating
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* 04. Core Services, Positioning & Client Sign-Off */}
          <section className="pt-3.5 border-t border-slate-200 grid grid-cols-12 gap-5">
            <div className="col-span-7">
              <h2 className="text-xs font-semibold text-slate-900 mb-2">
                04. Core Services &amp; Deliverables ({services.length})
              </h2>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                {services.slice(0, 4).map((srv, idx) => (
                  <div key={srv.id} className="min-w-0">
                    <p className="text-[11px] font-semibold text-slate-900 truncate">
                      <span className="font-mono pitch-accent-text tabular-nums mr-1">
                        {String(idx + 1).padStart(2, '0')}.
                      </span>
                      {srv.title}
                    </p>
                    <p className="text-[10px] text-slate-600 line-clamp-2 leading-snug mt-0.5">
                      {srv.deliverable
                        ? `${srv.deliverable} — ${srv.description}`
                        : srv.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="col-span-5 border-l border-slate-200 pl-5 flex flex-col justify-between">
              <div>
                <h2 className="text-xs font-semibold text-slate-900 mb-1.5">
                  05. {saved3DRender && !render3dLoadFailed ? '3D Showcase & Sign-Off' : 'Credentials & Launch Sign-Off'}
                </h2>

                {saved3DRender && !render3dLoadFailed && (
                  <div className="mb-2 flex items-center gap-2.5 pb-2 border-b border-slate-100">
                    <img
                      src={saved3DRender.dataUrl}
                      alt={saved3DRender.label}
                      referrerPolicy="no-referrer"
                      onError={() => setRender3dLoadFailed(true)}
                      className="w-24 h-14 object-cover rounded border border-slate-200 bg-slate-950 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold text-slate-900 truncate">
                        {saved3DRender.label.replace(/^3D Stage:\s*/i, '')}
                      </p>
                      <p className="text-[9px] text-slate-500 font-mono tabular-nums mt-0.5">
                        3D Stage Snapshot · Ready for client review
                      </p>
                    </div>
                  </div>
                )}

                {cleanCredentials.length > 0 && (
                  <p className="text-[10px] text-slate-700 line-clamp-2 mb-1.5">
                    <strong className="text-slate-900">Credentials:</strong>{' '}
                    {cleanCredentials.slice(0, 4).join(' · ')}
                  </p>
                )}
                <p className="text-[10px] text-slate-600 leading-relaxed line-clamp-2 whitespace-pre-line">
                  {siteNotes.trim()
                    ? siteNotes.trim().slice(0, 200)
                    : 'Confirm service area details, brand palette, typography pairing, and primary phone/email before publishing live.'}
                </p>
              </div>

              <div className="pt-2.5 mt-2.5 border-t border-slate-200 flex items-center justify-between gap-2 text-[10px] text-slate-600 font-mono">
                <span>Approved: _______________</span>
                <span>Date: __________</span>
              </div>
            </div>
          </section>
        </div>
      </article>
    </div>
  );
}
