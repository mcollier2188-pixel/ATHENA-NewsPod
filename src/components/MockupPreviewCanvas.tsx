import { useEffect, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Clock,
  GripVertical,
  Lock,
  Mail,
  MapPin,
  Menu,
  Phone,
  X,
} from 'lucide-react';
import type { MockupSectionKey, MockupViewport, SiteMockupProject } from '../types';
import { normalizeSectionOrder } from '../data/defaultMockup';
import { resolvePaletteTextColors } from '../utils/colorContrast';
import {
  buildMockupFontCssVars,
  ensureGoogleFontsLoaded,
  resolveActiveFontPairing,
} from '../utils/googleFonts';

interface MockupPreviewCanvasProps {
  project: SiteMockupProject;
  viewport: MockupViewport;
  allowSectionDrag?: boolean;
  lockedSections?: Partial<Record<MockupSectionKey, boolean>>;
  selectedLayer?: 'hero' | MockupSectionKey | 'footer' | null;
  onReorderSections?: (nextOrder: MockupSectionKey[]) => void;
  onSelectLayer?: (target: 'hero' | MockupSectionKey | 'footer') => void;
}

const SECTION_META: Record<
  MockupSectionKey,
  { anchorId: string; navLabel: string; displayLabel: string }
> = {
  services: { anchorId: 'mockup-services', navLabel: 'Services', displayLabel: 'Core Services' },
  projects: { anchorId: 'mockup-projects', navLabel: 'Projects', displayLabel: 'Recent Projects' },
  about: { anchorId: 'mockup-about', navLabel: 'About', displayLabel: 'About & Credentials' },
  quote: { anchorId: 'mockup-quote', navLabel: 'Contact', displayLabel: 'Quote Form' },
};

export function MockupPreviewCanvas({
  project,
  viewport,
  allowSectionDrag = false,
  lockedSections = {},
  selectedLayer = null,
  onReorderSections,
  onSelectLayer,
}: MockupPreviewCanvasProps) {
  const { brand, hero, services, projects, about, quoteForm, sectionVisibility } =
    project;

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [quoteName, setQuoteName] = useState('');
  const [quoteContact, setQuoteContact] = useState('');
  const [quoteDetails, setQuoteDetails] = useState('');
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteSubmitted, setQuoteSubmitted] = useState(false);
  const [draggedSection, setDraggedSection] = useState<MockupSectionKey | null>(null);
  const [dragOverSection, setDragOverSection] = useState<MockupSectionKey | null>(null);

  const isDark = brand.palette.canvasMode === 'dark';
  const resolvedColors = resolvePaletteTextColors(brand.palette);
  const primary = resolvedColors.primary;
  const accent = resolvedColors.accent;
  const onPrimary = resolvedColors.onPrimary;
  const onAccent = resolvedColors.onAccent;
  const heroKickerText = resolvedColors.heroKickerText;
  const accentText = resolvedColors.accentText;

  const bgColor = isDark ? '#0F131A' : '#F8FAFC';
  const surfaceColor = isDark ? '#161C26' : '#FFFFFF';
  const altSurfaceColor = isDark ? '#121720' : '#F1F5F9';
  const inkColor = isDark ? '#F8FAFC' : '#0F172A';
  const mutedInkColor = isDark ? '#94A3B8' : '#475569';
  const subtleBorderColor = isDark
    ? 'rgba(148, 163, 184, 0.16)'
    : 'rgba(15, 23, 42, 0.1)';

  const activeFontPairing = resolveActiveFontPairing(brand.fontMood, brand.fontPairing);
  const { cssVariables: fontCssVars } = buildMockupFontCssVars(activeFontPairing);

  useEffect(() => {
    ensureGoogleFontsLoaded([
      activeFontPairing.headingFont,
      activeFontPairing.bodyFont,
      activeFontPairing.monoFont || 'IBM Plex Mono',
    ]);
    // Also mirror mockup font CSS variables on :root so any mockup portals/exports stay synchronized
    const root = document.documentElement;
    Object.entries(fontCssVars).forEach(([varName, value]) => {
      root.style.setProperty(varName, value);
    });
  }, [
    activeFontPairing.headingFont,
    activeFontPairing.bodyFont,
    activeFontPairing.monoFont,
    fontCssVars,
  ]);

  const headingFontClass =
    activeFontPairing.headingCategory === 'serif'
      ? 'mockup-heading-font tracking-tight'
      : brand.fontMood === 'industrial'
        ? 'mockup-heading-font font-bold tracking-[-0.025em]'
        : 'mockup-heading-font font-semibold tracking-[-0.02em]';

  const isCompactFrame = viewport === 'mobile';
  const isTabletFrame = viewport === 'tablet';

  const sectionOrder = normalizeSectionOrder(project.sectionOrder);
  const visibleSectionOrder = sectionOrder.filter((key) => sectionVisibility[key]);

  const navLinks = visibleSectionOrder.map((key) => ({
    id: SECTION_META[key].anchorId,
    label: SECTION_META[key].navLabel,
  }));

  function reorderByKeys(sourceKey: MockupSectionKey, targetKey: MockupSectionKey) {
    if (
      !onReorderSections ||
      sourceKey === targetKey ||
      lockedSections[sourceKey] ||
      lockedSections[targetKey]
    ) {
      return;
    }
    // Keep locked layers pinned at their exact indices while reordering unlocked layers around them
    const unlockedIndices: number[] = [];
    const unlockedKeys: MockupSectionKey[] = [];
    sectionOrder.forEach((key, idx) => {
      if (!lockedSections[key]) {
        unlockedIndices.push(idx);
        unlockedKeys.push(key);
      }
    });
    const fromPos = unlockedKeys.indexOf(sourceKey);
    const toPos = unlockedKeys.indexOf(targetKey);
    if (fromPos === -1 || toPos === -1) return;
    const [moved] = unlockedKeys.splice(fromPos, 1);
    unlockedKeys.splice(toPos, 0, moved);

    const next = [...sectionOrder];
    unlockedIndices.forEach((slotIdx, i) => {
      next[slotIdx] = unlockedKeys[i];
    });
    onReorderSections(next);
  }

  const unlockedVisibleOrder = visibleSectionOrder.filter((key) => !lockedSections[key]);

  function nudgeVisibleSection(key: MockupSectionKey, direction: -1 | 1) {
    if (!onReorderSections || lockedSections[key]) return;
    const visibleIdx = unlockedVisibleOrder.indexOf(key);
    const neighborKey = unlockedVisibleOrder[visibleIdx + direction];
    if (!neighborKey) return;
    reorderByKeys(key, neighborKey);
  }

  function handleCanvasDragStart(e: DragEvent<HTMLElement>, key: MockupSectionKey) {
    if (!allowSectionDrag || lockedSections[key]) {
      e.preventDefault();
      return;
    }
    setDraggedSection(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  }

  function handleCanvasDragOver(e: DragEvent<HTMLElement>, key: MockupSectionKey) {
    if (
      !allowSectionDrag ||
      !draggedSection ||
      draggedSection === key ||
      lockedSections[key]
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverSection !== key) {
      setDragOverSection(key);
    }
  }

  function handleCanvasDrop(e: DragEvent<HTMLElement>, targetKey: MockupSectionKey) {
    if (!allowSectionDrag) return;
    e.preventDefault();
    const sourceKey = (draggedSection ||
      (e.dataTransfer.getData('text/plain') as MockupSectionKey)) as MockupSectionKey;
    if (
      sourceKey &&
      sourceKey !== targetKey &&
      !lockedSections[sourceKey] &&
      !lockedSections[targetKey]
    ) {
      reorderByKeys(sourceKey, targetKey);
    }
    setDraggedSection(null);
    setDragOverSection(null);
  }

  function handleCanvasDragEnd() {
    setDraggedSection(null);
    setDragOverSection(null);
  }

  function scrollToAnchor(id: string) {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function handleQuoteSubmit(e: FormEvent) {
    e.preventDefault();
    setQuoteError(null);
    if (!quoteName.trim() || !quoteContact.trim() || !quoteDetails.trim()) {
      setQuoteError('Please fill in your name, phone or email, and a quick note on the job.');
      return;
    }
    setQuoteSubmitted(true);
    setQuoteName('');
    setQuoteContact('');
    setQuoteDetails('');
  }

  const themeVars = {
    '--m-primary': primary,
    '--m-accent': accent,
    '--m-on-primary': onPrimary,
    '--m-on-accent': onAccent,
    '--m-bg': bgColor,
    '--m-surface': surfaceColor,
    '--m-alt': altSurfaceColor,
    '--m-ink': inkColor,
    '--m-muted': mutedInkColor,
    '--m-border': subtleBorderColor,
    ...fontCssVars,
  } as CSSProperties;

  const frameWidthClass =
    viewport === 'mobile'
      ? 'max-w-[390px] mx-auto shadow-2xl border border-[#2A3342] rounded-xl'
      : viewport === 'tablet'
        ? 'max-w-[780px] mx-auto shadow-2xl border border-[#2A3342] rounded-xl'
        : 'w-full border border-[#222833] rounded-lg';

  return (
    <div
      style={{
        ...themeVars,
        backgroundColor: bgColor,
        color: inkColor,
      }}
      className={`${frameWidthClass} mockup-canvas-smooth mockup-typography-scope overflow-hidden transition-all duration-200`}
    >
      {/* Client Site Top Navigation (3-zone contract) */}
      <header
        style={{
          backgroundColor: surfaceColor,
          borderBottom: `1px solid ${subtleBorderColor}`,
        }}
        className="sticky top-0 z-10"
      >
        <div
          className={`max-w-[1140px] mx-auto ${
            isCompactFrame ? 'px-4 h-14' : 'px-6 sm:px-8 h-16'
          } flex items-center justify-between gap-6`}
        >
          <button
            type="button"
            onClick={() => scrollToAnchor('mockup-top')}
            className={`${headingFontClass} inline-flex items-center gap-2.5 text-base sm:text-lg whitespace-nowrap shrink-0 cursor-pointer text-left`}
            style={{ color: inkColor }}
          >
            {brand.logoDataUrl && (
              <img
                src={brand.logoDataUrl}
                alt={`${brand.name || 'Company'} logo`}
                referrerPolicy="no-referrer"
                className="h-7 sm:h-8 w-auto max-w-[130px] object-contain shrink-0"
              />
            )}
            <span>{brand.name || 'Your Business Name'}</span>
          </button>

          {!isCompactFrame && (
            <nav aria-label="Mockup preview navigation" className="hidden md:flex items-center gap-6">
              {navLinks.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  onClick={() => scrollToAnchor(link.id)}
                  style={{ color: mutedInkColor }}
                  className="text-sm font-medium hover:opacity-100 opacity-85 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {link.label}
                </button>
              ))}
            </nav>
          )}

          <div className="flex items-center gap-2 shrink-0">
            {!isCompactFrame && (
              <button
                type="button"
                onClick={() => scrollToAnchor('mockup-quote')}
                style={{ backgroundColor: accent, color: onAccent }}
                className="h-9 px-4 text-xs sm:text-sm font-semibold rounded-md hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
              >
                {hero.primaryCta || 'Get a Quote'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle preview menu"
              className={`${
                isCompactFrame ? 'inline-flex' : 'md:hidden inline-flex'
              } w-9 h-9 items-center justify-center rounded-md cursor-pointer`}
              style={{
                border: `1px solid ${subtleBorderColor}`,
                color: inkColor,
              }}
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Preview Mobile Menu Drawer */}
        {mobileMenuOpen && (
          <div
            style={{
              backgroundColor: surfaceColor,
              borderTop: `1px solid ${subtleBorderColor}`,
            }}
            className="px-5 py-4 space-y-2.5"
          >
            {navLinks.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => scrollToAnchor(link.id)}
                className="block w-full text-left py-1.5 text-sm font-medium cursor-pointer"
                style={{ color: inkColor }}
              >
                {link.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => scrollToAnchor('mockup-quote')}
              style={{ backgroundColor: accent, color: onAccent }}
              className="w-full h-10 mt-2 text-sm font-semibold rounded-md cursor-pointer"
            >
              {hero.primaryCta || 'Request a Quote'}
            </button>
          </div>
        )}
      </header>

      {/* Hero Section */}
      <section
        id="mockup-top"
        style={{
          backgroundColor: primary,
          color: onPrimary,
        }}
        className={`${
          isCompactFrame ? 'px-5 py-12' : 'px-6 sm:px-10 py-16 sm:py-20'
        } ${
          allowSectionDrag && selectedLayer === 'hero'
            ? 'ring-2 ring-inset ring-[#22D3EE]/80'
            : ''
        }`}
      >
        <div className="max-w-[1140px] mx-auto">
          <div
            className={
              hero.photoDataUrl && !isCompactFrame
                ? 'grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch'
                : ''
            }
          >
            <div className={hero.photoDataUrl && !isCompactFrame ? 'lg:col-span-7 flex flex-col justify-center' : ''}>
              <p
                className="text-xs sm:text-sm font-semibold tracking-wide"
                style={{ color: heroKickerText }}
              >
                {hero.kicker}
                {brand.serviceArea ? ` · ${brand.serviceArea}` : ''}
              </p>

              <h1
                className={`mt-3 ${headingFontClass} ${
                  isCompactFrame
                    ? 'text-3xl leading-[1.14]'
                    : 'text-4xl sm:text-5xl leading-[1.1]'
                } max-w-[19ch] [text-wrap:balance]`}
              >
                {hero.headline}
              </h1>

              <p
                className="mt-4 text-base sm:text-lg leading-relaxed max-w-[60ch]"
                style={{ opacity: 0.88 }}
              >
                {hero.subheadline}
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => scrollToAnchor('mockup-quote')}
                  style={{ backgroundColor: accent, color: onAccent }}
                  className="h-11 px-6 inline-flex items-center gap-2 text-sm font-semibold rounded-md hover:opacity-90 transition-opacity whitespace-nowrap cursor-pointer"
                >
                  <span>{hero.primaryCta || 'Request a Quote'}</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>

                {hero.secondaryCta && sectionVisibility.services && (
                  <button
                    type="button"
                    onClick={() => scrollToAnchor('mockup-services')}
                    style={{
                      border: `1px solid ${
                        onPrimary === '#FFFFFF'
                          ? 'rgba(255,255,255,0.35)'
                          : 'rgba(15,23,42,0.35)'
                      }`,
                      color: onPrimary,
                    }}
                    className="h-11 px-5 inline-flex items-center text-sm font-medium rounded-md hover:opacity-85 transition-opacity whitespace-nowrap cursor-pointer"
                  >
                    {hero.secondaryCta}
                  </button>
                )}
              </div>
            </div>

            {hero.photoDataUrl && (
              <div
                className={
                  isCompactFrame
                    ? 'mt-7 relative overflow-hidden rounded-lg aspect-[16/10]'
                    : 'lg:col-span-5 relative overflow-hidden rounded-lg min-h-[260px]'
                }
                style={{
                  border: `1px solid ${
                    onPrimary === '#FFFFFF'
                      ? 'rgba(255,255,255,0.2)'
                      : 'rgba(15,23,42,0.18)'
                  }`,
                }}
              >
                <img
                  src={hero.photoDataUrl}
                  alt={`${brand.name || 'Site'} featured work`}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 px-4 py-3 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
                  <p className="text-xs font-medium text-white">
                    {brand.industry}
                    {brand.serviceArea ? ` · ${brand.serviceArea}` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Unboxed Trust & Credibility Strip */}
          {hero.trustHighlights.filter(Boolean).length > 0 && (
            <div
              style={{
                borderTop: `1px solid ${
                  onPrimary === '#FFFFFF'
                    ? 'rgba(255,255,255,0.18)'
                    : 'rgba(15,23,42,0.16)'
                }`,
              }}
              className="mt-10 pt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs sm:text-sm font-medium tabular-nums"
            >
              {hero.trustHighlights.filter(Boolean).map((item, idx, arr) => (
                <span key={idx} className="inline-flex items-center gap-5">
                  <span style={{ opacity: 0.92 }}>{item}</span>
                  {idx < arr.length - 1 && (
                    <span aria-hidden="true" style={{ opacity: 0.45 }}>
                      ·
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Reorderable Body Sections */}
      {visibleSectionOrder.map((sectionKey, visibleIdx) => {
        const isAlt = visibleIdx % 2 === 1;
        const isLocked = Boolean(lockedSections[sectionKey]);
        const isSelected = allowSectionDrag && selectedLayer === sectionKey;
        const isDraggingThis = draggedSection === sectionKey;
        const isDropTarget =
          dragOverSection === sectionKey && draggedSection !== sectionKey && !isLocked;
        const unlockedVisibleIdx = unlockedVisibleOrder.indexOf(sectionKey);
        const canNudgeUp = !isLocked && unlockedVisibleIdx > 0;
        const canNudgeDown =
          !isLocked &&
          unlockedVisibleIdx !== -1 &&
          unlockedVisibleIdx < unlockedVisibleOrder.length - 1;

        const sectionStyle: CSSProperties = isAlt
          ? {
              backgroundColor: altSurfaceColor,
              borderTop: `1px solid ${subtleBorderColor}`,
              borderBottom: `1px solid ${subtleBorderColor}`,
            }
          : {
              backgroundColor: bgColor,
            };

        const dragOverlayBar = allowSectionDrag && onReorderSections && (
          <div
            data-export-ignore="true"
            className={`absolute top-2.5 right-3 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#0E1116]/90 border text-[#F5F7FA] shadow-lg transition-opacity duration-150 ${
              isLocked ? 'border-[#F59E0B]/60' : 'border-[#22D3EE]/50'
            } ${
              isDraggingThis || isDropTarget || isSelected
                ? 'opacity-100'
                : 'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100'
            }`}
          >
            {isLocked ? (
              <>
                <Lock className="w-3 h-3 text-[#F59E0B] shrink-0" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => onSelectLayer?.(sectionKey)}
                  className="text-[11px] font-medium whitespace-nowrap text-[#FDE68A] hover:underline cursor-pointer"
                >
                  {SECTION_META[sectionKey].displayLabel} · Locked
                </button>
              </>
            ) : (
              <>
                <GripVertical
                  className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => onSelectLayer?.(sectionKey)}
                  className="text-[11px] font-medium whitespace-nowrap hover:text-[#67E8F9] cursor-pointer"
                >
                  {SECTION_META[sectionKey].displayLabel}
                </button>
                <span className="text-[#475569] mx-0.5" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  disabled={!canNudgeUp}
                  onClick={() => nudgeVisibleSection(sectionKey, -1)}
                  aria-label={`Move ${SECTION_META[sectionKey].displayLabel} up`}
                  className="p-0.5 text-[#A0AABB] hover:text-[#67E8F9] disabled:opacity-30 cursor-pointer"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  disabled={!canNudgeDown}
                  onClick={() => nudgeVisibleSection(sectionKey, 1)}
                  aria-label={`Move ${SECTION_META[sectionKey].displayLabel} down`}
                  className="p-0.5 text-[#A0AABB] hover:text-[#67E8F9] disabled:opacity-30 cursor-pointer"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        );

        const isDraggableSection = allowSectionDrag && !isLocked;

        const wrapperClass = `group/section relative transition-[opacity,box-shadow] duration-150 ${
          isCompactFrame ? 'px-5 py-12' : 'px-6 sm:px-10 py-16'
        } ${isDraggableSection ? 'cursor-grab active:cursor-grabbing' : ''} ${
          isDraggingThis ? 'opacity-50' : ''
        } ${
          isDropTarget
            ? 'ring-2 ring-inset ring-[#22D3EE]'
            : isSelected
              ? 'ring-2 ring-inset ring-[#22D3EE]/75'
              : ''
        }`;

        if (sectionKey === 'services') {
          return (
            <section
              key="services"
              id="mockup-services"
              draggable={isDraggableSection}
              onDragStart={(e) => handleCanvasDragStart(e, 'services')}
              onDragOver={(e) => handleCanvasDragOver(e, 'services')}
              onDragLeave={() => setDragOverSection((curr) => (curr === 'services' ? null : curr))}
              onDrop={(e) => handleCanvasDrop(e, 'services')}
              onDragEnd={handleCanvasDragEnd}
              style={sectionStyle}
              className={wrapperClass}
            >
              {dragOverlayBar}
              <div className="max-w-[1140px] mx-auto">
                <div className="max-w-2xl">
                  <p className="text-xs font-semibold tracking-wide" style={{ color: accentText }}>
                    Core Services
                  </p>
                  <h2
                    className={`mt-1.5 ${headingFontClass} text-2xl sm:text-3xl leading-tight`}
                    style={{ color: inkColor }}
                  >
                    Practical work, priced clearly and built to last
                  </h2>
                </div>

                <div
                  className={`mt-8 grid gap-5 ${
                    isCompactFrame
                      ? 'grid-cols-1'
                      : isTabletFrame
                        ? 'grid-cols-2'
                        : 'grid-cols-1 md:grid-cols-2'
                  }`}
                >
                  {services.map((srv, idx) => (
                    <article
                      key={srv.id}
                      style={{
                        backgroundColor: surfaceColor,
                        border: `1px solid ${subtleBorderColor}`,
                      }}
                      className="rounded-lg p-6 flex flex-col justify-between"
                    >
                      <div>
                        <span
                          className="font-mono text-xs font-semibold tabular-nums"
                          style={{ color: accentText }}
                        >
                          {String(idx + 1).padStart(2, '0')}.
                        </span>
                        <h3
                          className={`mt-1.5 ${headingFontClass} text-lg sm:text-xl leading-snug`}
                          style={{ color: inkColor }}
                        >
                          {srv.title}
                        </h3>
                        <p
                          className="mt-2.5 text-sm leading-relaxed"
                          style={{ color: mutedInkColor }}
                        >
                          {srv.description}
                        </p>
                      </div>

                      {srv.deliverable && (
                        <p
                          style={{
                            borderTop: `1px solid ${subtleBorderColor}`,
                            color: inkColor,
                          }}
                          className="mt-5 pt-3.5 text-xs font-medium"
                        >
                          {srv.deliverable}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          );
        }

        if (sectionKey === 'projects') {
          return (
            <section
              key="projects"
              id="mockup-projects"
              draggable={isDraggableSection}
              onDragStart={(e) => handleCanvasDragStart(e, 'projects')}
              onDragOver={(e) => handleCanvasDragOver(e, 'projects')}
              onDragLeave={() => setDragOverSection((curr) => (curr === 'projects' ? null : curr))}
              onDrop={(e) => handleCanvasDrop(e, 'projects')}
              onDragEnd={handleCanvasDragEnd}
              style={sectionStyle}
              className={wrapperClass}
            >
              {dragOverlayBar}
              <div className="max-w-[1140px] mx-auto">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold tracking-wide" style={{ color: accentText }}>
                      Recent Work
                    </p>
                    <h2
                      className={`mt-1.5 ${headingFontClass} text-2xl sm:text-3xl leading-tight`}
                      style={{ color: inkColor }}
                    >
                      Completed jobs &amp; site outcomes
                    </h2>
                  </div>
                  {brand.serviceArea && (
                    <p className="text-xs font-medium" style={{ color: mutedInkColor }}>
                      Serving {brand.serviceArea}
                    </p>
                  )}
                </div>

                <div
                  className={`mt-8 grid gap-5 ${
                    isCompactFrame
                      ? 'grid-cols-1'
                      : isTabletFrame
                        ? 'grid-cols-2'
                        : 'grid-cols-1 lg:grid-cols-3'
                  }`}
                >
                  {projects.map((prj) => (
                    <article
                      key={prj.id}
                      style={{
                        backgroundColor: surfaceColor,
                        border: `1px solid ${subtleBorderColor}`,
                      }}
                      className="rounded-lg overflow-hidden flex flex-col"
                    >
                      {prj.photoDataUrl && (
                        <div className="aspect-[16/10] w-full overflow-hidden">
                          <img
                            src={prj.photoDataUrl}
                            alt={prj.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}
                      <div className="p-6 flex-1">
                        <div
                          className="flex flex-wrap items-center gap-1.5 text-xs tabular-nums"
                          style={{ color: mutedInkColor }}
                        >
                          <span>{prj.location}</span>
                          {prj.metric && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold" style={{ color: accentText }}>
                                {prj.metric}
                              </span>
                            </>
                          )}
                        </div>
                        <h3
                          className={`mt-2 ${headingFontClass} text-lg leading-snug`}
                          style={{ color: inkColor }}
                        >
                          {prj.title}
                        </h3>
                        <p
                          className="mt-2 text-sm leading-relaxed"
                          style={{ color: mutedInkColor }}
                        >
                          {prj.summary}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          );
        }

        if (sectionKey === 'about') {
          return (
            <section
              key="about"
              id="mockup-about"
              draggable={isDraggableSection}
              onDragStart={(e) => handleCanvasDragStart(e, 'about')}
              onDragOver={(e) => handleCanvasDragOver(e, 'about')}
              onDragLeave={() => setDragOverSection((curr) => (curr === 'about' ? null : curr))}
              onDrop={(e) => handleCanvasDrop(e, 'about')}
              onDragEnd={handleCanvasDragEnd}
              style={sectionStyle}
              className={wrapperClass}
            >
              {dragOverlayBar}
              <div
                className={`max-w-[1140px] mx-auto grid gap-8 items-start ${
                  isCompactFrame ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-12'
                }`}
              >
                <div className={isCompactFrame ? '' : 'lg:col-span-7'}>
                  <p className="text-xs font-semibold tracking-wide" style={{ color: accentText }}>
                    About {brand.name}
                  </p>
                  <h2
                    className={`mt-1.5 ${headingFontClass} text-2xl sm:text-3xl leading-tight max-w-[24ch]`}
                    style={{ color: inkColor }}
                  >
                    {about.heading}
                  </h2>
                  <p
                    className="mt-4 text-sm sm:text-base leading-relaxed max-w-[62ch]"
                    style={{ color: mutedInkColor }}
                  >
                    {about.story}
                  </p>
                </div>

                <div className={isCompactFrame ? '' : 'lg:col-span-5'}>
                  <ul className="space-y-3">
                    {about.credentials.filter(Boolean).map((cred, idx) => (
                      <li
                        key={idx}
                        style={{
                          backgroundColor: surfaceColor,
                          border: `1px solid ${subtleBorderColor}`,
                        }}
                        className="rounded-lg px-4 py-3.5 flex items-start gap-3 text-sm"
                      >
                        <span
                          className="font-mono text-xs font-semibold tabular-nums mt-0.5 shrink-0"
                          style={{ color: accentText }}
                        >
                          {String(idx + 1).padStart(2, '0')}.
                        </span>
                        <span style={{ color: inkColor }}>{cred}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          );
        }

        return (
          <section
            key="quote"
            id="mockup-quote"
            draggable={isDraggableSection}
            onDragStart={(e) => handleCanvasDragStart(e, 'quote')}
            onDragOver={(e) => handleCanvasDragOver(e, 'quote')}
            onDragLeave={() => setDragOverSection((curr) => (curr === 'quote' ? null : curr))}
            onDrop={(e) => handleCanvasDrop(e, 'quote')}
            onDragEnd={handleCanvasDragEnd}
            style={sectionStyle}
            className={wrapperClass}
          >
            {dragOverlayBar}
            <div
              className={`max-w-[1140px] mx-auto grid gap-10 items-start ${
                isCompactFrame ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-12'
              }`}
            >
              <div className={isCompactFrame ? '' : 'lg:col-span-5'}>
                <p className="text-xs font-semibold tracking-wide" style={{ color: accentText }}>
                  Direct Enquiry
                </p>
                <h2
                  className={`mt-1.5 ${headingFontClass} text-2xl sm:text-3xl leading-tight`}
                  style={{ color: inkColor }}
                >
                  {quoteForm.heading}
                </h2>
                <p
                  className="mt-3 text-sm leading-relaxed"
                  style={{ color: mutedInkColor }}
                >
                  {quoteForm.subtext}
                </p>

                <dl className="mt-6 space-y-3 text-sm">
                  {brand.phone && (
                    <div className="flex items-center gap-2.5">
                      <Phone className="w-4 h-4 shrink-0" style={{ color: accentText }} aria-hidden="true" />
                      <dd className="font-mono tabular-nums font-medium" style={{ color: inkColor }}>
                        {brand.phone}
                      </dd>
                    </div>
                  )}
                  {brand.email && (
                    <div className="flex items-center gap-2.5">
                      <Mail className="w-4 h-4 shrink-0" style={{ color: accentText }} aria-hidden="true" />
                      <dd style={{ color: inkColor }}>{brand.email}</dd>
                    </div>
                  )}
                  {brand.serviceArea && (
                    <div className="flex items-center gap-2.5">
                      <MapPin className="w-4 h-4 shrink-0" style={{ color: accentText }} aria-hidden="true" />
                      <dd style={{ color: mutedInkColor }}>{brand.serviceArea}</dd>
                    </div>
                  )}
                  {brand.hours && (
                    <div className="flex items-center gap-2.5">
                      <Clock className="w-4 h-4 shrink-0" style={{ color: accentText }} aria-hidden="true" />
                      <dd style={{ color: mutedInkColor }}>{brand.hours}</dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className={isCompactFrame ? '' : 'lg:col-span-7'}>
                <form
                  onSubmit={handleQuoteSubmit}
                  noValidate
                  style={{
                    backgroundColor: surfaceColor,
                    border: `1px solid ${subtleBorderColor}`,
                  }}
                  className="rounded-lg p-6 space-y-4"
                >
                  {quoteSubmitted ? (
                    <div className="py-6 text-center space-y-2.5">
                      <CheckCircle2
                        className="w-8 h-8 mx-auto"
                        style={{ color: accentText }}
                        aria-hidden="true"
                      />
                      <p className="font-semibold text-base" style={{ color: inkColor }}>
                        Enquiry preview submitted
                      </p>
                      <p className="text-sm max-w-sm mx-auto" style={{ color: mutedInkColor }}>
                        This demonstrates the live confirmation state your mate&apos;s customers will see after requesting a quote.
                      </p>
                      <button
                        type="button"
                        onClick={() => setQuoteSubmitted(false)}
                        style={{ color: accentText }}
                        className="mt-2 text-xs font-semibold hover:underline cursor-pointer"
                      >
                        Reset demo form
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className={`grid gap-4 ${
                          isCompactFrame ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'
                        }`}
                      >
                        <div>
                          <label
                            htmlFor="mockup-q-name"
                            className="block text-xs font-semibold mb-1.5"
                            style={{ color: inkColor }}
                          >
                            Your Name
                          </label>
                          <input
                            id="mockup-q-name"
                            type="text"
                            value={quoteName}
                            onChange={(e) => setQuoteName(e.target.value)}
                            placeholder="e.g., Dave Turner"
                            style={{
                              backgroundColor: bgColor,
                              border: `1px solid ${subtleBorderColor}`,
                              color: inkColor,
                            }}
                            className="w-full h-10 px-3 text-sm rounded-md"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor="mockup-q-contact"
                            className="block text-xs font-semibold mb-1.5"
                            style={{ color: inkColor }}
                          >
                            Phone or Email
                          </label>
                          <input
                            id="mockup-q-contact"
                            type="text"
                            value={quoteContact}
                            onChange={(e) => setQuoteContact(e.target.value)}
                            placeholder="07... or name@email.co.uk"
                            style={{
                              backgroundColor: bgColor,
                              border: `1px solid ${subtleBorderColor}`,
                              color: inkColor,
                            }}
                            className="w-full h-10 px-3 text-sm rounded-md"
                          />
                        </div>
                      </div>

                      <div>
                        <label
                          htmlFor="mockup-q-details"
                          className="block text-xs font-semibold mb-1.5"
                          style={{ color: inkColor }}
                        >
                          Job Scope &amp; Postcode
                        </label>
                        <textarea
                          id="mockup-q-details"
                          rows={3}
                          value={quoteDetails}
                          onChange={(e) => setQuoteDetails(e.target.value)}
                          placeholder="Rough dimensions, location postcode, and ideal start window..."
                          style={{
                            backgroundColor: bgColor,
                            border: `1px solid ${subtleBorderColor}`,
                            color: inkColor,
                          }}
                          className="w-full p-3 text-sm rounded-md leading-relaxed"
                        />
                      </div>

                      {quoteError && (
                        <p role="alert" className="text-xs font-medium text-red-500">
                          {quoteError}
                        </p>
                      )}

                      <button
                        type="submit"
                        style={{ backgroundColor: accent, color: onAccent }}
                        className="h-11 px-6 text-sm font-semibold rounded-md hover:opacity-90 transition-opacity whitespace-nowrap cursor-pointer"
                      >
                        {quoteForm.submitLabel || 'Send Quote Enquiry'}
                      </button>
                    </>
                  )}
                </form>
              </div>
            </div>
          </section>
        );
      })}

      {/* Quiet Footer */}
      <footer
        id="mockup-footer"
        style={{
          backgroundColor: surfaceColor,
          borderTop: `1px solid ${subtleBorderColor}`,
          color: mutedInkColor,
        }}
        className={`${isCompactFrame ? 'px-5 py-6' : 'px-6 sm:px-10 py-8'} ${
          allowSectionDrag && selectedLayer === 'footer'
            ? 'ring-2 ring-inset ring-[#22D3EE]/80'
            : ''
        }`}
      >
        <div className="max-w-[1140px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="font-medium" style={{ color: inkColor }}>
            © {new Date().getFullYear()} {brand.name}
          </span>
          <span>
            {[brand.industry, brand.address].filter(Boolean).join(' · ')}
          </span>
        </div>
      </footer>
    </div>
  );
}
