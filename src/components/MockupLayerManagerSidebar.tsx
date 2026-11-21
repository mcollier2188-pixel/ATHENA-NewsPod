import { useState, type DragEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  GripVertical,
  History,
  ImageDown,
  Layers,
  Loader2,
  Lock,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  Unlock,
  X,
} from 'lucide-react';
import type { MockupSectionKey, SiteMockupProject } from '../types';
import { DEFAULT_SECTION_ORDER } from '../data/defaultMockup';
import type { ExportableCanvasSectionKey } from '../utils/sectionPngExport';

export type MockupLayerTarget = ExportableCanvasSectionKey;

interface MockupLayerManagerSidebarProps {
  project: SiteMockupProject;
  orderedSections: MockupSectionKey[];
  lockedSections: Partial<Record<MockupSectionKey, boolean>>;
  selectedLayer: MockupLayerTarget | null;
  selectedExportSections: ExportableCanvasSectionKey[];
  isExportingPngs: boolean;
  exportingSingleKey: ExportableCanvasSectionKey | null;
  pngExportNotice: string | null;
  onSelectLayer: (target: MockupLayerTarget) => void;
  onToggleExportSelection: (key: ExportableCanvasSectionKey) => void;
  onSelectAllExportSections: () => void;
  onClearExportSections: () => void;
  onQuickExportSinglePng: (key: ExportableCanvasSectionKey) => void;
  onQuickExportSelectedPngs: () => void;
  onOpenPngExportModal: () => void;
  onToggleVisibility: (key: MockupSectionKey) => void;
  onToggleLock: (key: MockupSectionKey) => void;
  onMoveSection: (sourceKey: MockupSectionKey, targetKey: MockupSectionKey) => void;
  onNudgeSection: (key: MockupSectionKey, direction: -1 | 1) => void;
  onShowAllSections: () => void;
  onUnlockAllSections: () => void;
  onResetOrder: () => void;
  onSwitchToVersions?: () => void;
  onClose: () => void;
}

const SECTION_LAYER_INFO: Record<
  MockupSectionKey,
  { title: string; getDetail: (project: SiteMockupProject) => string }
> = {
  services: {
    title: 'Core Services',
    getDetail: (p) => `${p.services.length} ${p.services.length === 1 ? 'service' : 'services'}`,
  },
  projects: {
    title: 'Recent Projects',
    getDetail: (p) => `${p.projects.length} ${p.projects.length === 1 ? 'job' : 'jobs'}`,
  },
  about: {
    title: 'About & Story',
    getDetail: (p) => {
      const creds = p.about.credentials.filter(Boolean).length;
      return `${creds} ${creds === 1 ? 'credential' : 'credentials'}`;
    },
  },
  quote: {
    title: 'Quote & Contact',
    getDetail: () => 'Enquiry form',
  },
};

export function MockupLayerManagerSidebar({
  project,
  orderedSections,
  lockedSections,
  selectedLayer,
  selectedExportSections,
  isExportingPngs,
  exportingSingleKey,
  pngExportNotice,
  onSelectLayer,
  onToggleExportSelection,
  onSelectAllExportSections,
  onClearExportSections,
  onQuickExportSinglePng,
  onQuickExportSelectedPngs,
  onOpenPngExportModal,
  onToggleVisibility,
  onToggleLock,
  onMoveSection,
  onNudgeSection,
  onShowAllSections,
  onUnlockAllSections,
  onResetOrder,
  onSwitchToVersions,
  onClose,
}: MockupLayerManagerSidebarProps) {
  const [draggedKey, setDraggedKey] = useState<MockupSectionKey | null>(null);
  const [dragOverKey, setDragOverKey] = useState<MockupSectionKey | null>(null);

  const visibleCount = orderedSections.filter((k) => project.sectionVisibility[k]).length;
  const lockedCount = orderedSections.filter((k) => Boolean(lockedSections[k])).length;
  const hiddenUnlockedCount = orderedSections.filter(
    (k) => !project.sectionVisibility[k] && !lockedSections[k]
  ).length;
  const isCustomOrder = orderedSections.some((key, idx) => key !== DEFAULT_SECTION_ORDER[idx]);
  const unlockedKeys = orderedSections.filter((k) => !lockedSections[k]);

  const visibleExportSelectedCount = selectedExportSections.filter((k) =>
    k === 'hero' || k === 'footer' ? true : Boolean(project.sectionVisibility[k])
  ).length;

  function handleDragStart(e: DragEvent<HTMLDivElement>, key: MockupSectionKey) {
    if (lockedSections[key]) {
      e.preventDefault();
      return;
    }
    setDraggedKey(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, targetKey: MockupSectionKey) {
    if (!draggedKey || draggedKey === targetKey || lockedSections[targetKey]) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverKey !== targetKey) {
      setDragOverKey(targetKey);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>, targetKey: MockupSectionKey) {
    e.preventDefault();
    const sourceKey = (draggedKey ||
      (e.dataTransfer.getData('text/plain') as MockupSectionKey)) as MockupSectionKey;
    if (
      sourceKey &&
      sourceKey !== targetKey &&
      !lockedSections[sourceKey] &&
      !lockedSections[targetKey]
    ) {
      onMoveSection(sourceKey, targetKey);
    }
    setDraggedKey(null);
    setDragOverKey(null);
  }

  function handleDragEnd() {
    setDraggedKey(null);
    setDragOverKey(null);
  }

  const isHeroChecked = selectedExportSections.includes('hero');
  const isFooterChecked = selectedExportSections.includes('footer');

  return (
    <aside
      aria-label="Canvas layer manager"
      className="w-full lg:w-[272px] xl:w-[292px] shrink-0 bg-[#101319] border-t lg:border-t-0 lg:border-l border-[#222833] flex flex-col"
    >
      {/* Sidebar Header */}
      <div className="px-3.5 py-3 border-b border-[#1F2532] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-[#F5F7FA] leading-tight">
              Layers
            </h2>
            <p className="font-mono text-[10px] text-[#8C96A8] tabular-nums mt-0.5">
              {visibleCount}/{orderedSections.length} shown
              {lockedCount > 0 ? ` · ${lockedCount} locked` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onSwitchToVersions && (
            <button
              type="button"
              onClick={onSwitchToVersions}
              title="Switch to version history sidebar"
              aria-label="Switch to version history sidebar"
              className="h-7 px-2 inline-flex items-center gap-1 rounded text-[11px] font-medium text-[#8C96A8] hover:text-[#F5F7FA] hover:bg-[#18212E] transition-colors whitespace-nowrap cursor-pointer"
            >
              <History className="w-3 h-3" aria-hidden="true" />
              History
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide layers sidebar"
            title="Hide layers sidebar"
            className="w-7 h-7 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#F5F7FA] hover:bg-[#18212E] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Layer Tree */}
      <div className="p-3 space-y-2 overflow-y-auto lg:max-h-[calc(100vh-15.5rem)] flex-1">
        {/* Pinned Top Layer: Navigation & Hero */}
        <div
          className={`px-2 py-2 rounded-md border flex items-center justify-between gap-1.5 transition-colors ${
            selectedLayer === 'hero'
              ? 'bg-[#131C26] border-[#22D3EE]/70'
              : isHeroChecked
                ? 'bg-[#0F161F] border-[#22D3EE]/40'
                : 'bg-[#0B0D10] border-[#1F2532] hover:border-[#2A3342]'
          }`}
        >
          <input
            type="checkbox"
            checked={isHeroChecked}
            onChange={() => onToggleExportSelection('hero')}
            aria-label="Select Header & Hero for transparent PNG export"
            title="Include Header & Hero in PNG export"
            className="accent-[#22D3EE] w-3.5 h-3.5 shrink-0 cursor-pointer"
          />
          <button
            type="button"
            onClick={() => onSelectLayer('hero')}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
          >
            <Pin className="w-3 h-3 text-[#6E788A] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#E4E9F1] truncate">
                Header &amp; Hero
              </p>
              <p className="text-[10px] text-[#6E788A] truncate">
                Pinned top · {project.hero.photoDataUrl ? 'With photo' : 'Text hero'}
              </p>
            </div>
          </button>
          <button
            type="button"
            disabled={isExportingPngs}
            onClick={() => onQuickExportSinglePng('hero')}
            aria-label="Export Header & Hero as transparent PNG"
            title="Export Header & Hero as transparent PNG"
            className="w-6 h-6 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-35 cursor-pointer shrink-0"
          >
            {exportingSingleKey === 'hero' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" />
            ) : (
              <ImageDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Section Divider */}
        <div className="pt-1 flex items-center justify-between gap-2 px-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6E788A]">
            Canvas Sections
          </span>
          <span className="text-[10px] text-[#6E788A]">
            PNG · Hide · Lock
          </span>
        </div>

        {/* Draggable Body Section Layers */}
        <div
          role="list"
          aria-label="Canvas section layers"
          className="space-y-1.5"
        >
          {orderedSections.map((key, idx) => {
            const info = SECTION_LAYER_INFO[key];
            const isVisible = project.sectionVisibility[key];
            const isLocked = Boolean(lockedSections[key]);
            const isSelected = selectedLayer === key;
            const isCheckedForPng = isVisible && selectedExportSections.includes(key);
            const isDragging = draggedKey === key;
            const isDropTarget = dragOverKey === key && draggedKey !== key && !isLocked;

            const unlockedPos = unlockedKeys.indexOf(key);
            const canMoveUp = !isLocked && unlockedPos > 0;
            const canMoveDown =
              !isLocked && unlockedPos !== -1 && unlockedPos < unlockedKeys.length - 1;

            return (
              <div
                key={key}
                role="listitem"
                draggable={!isLocked}
                onDragStart={(e) => handleDragStart(e, key)}
                onDragOver={(e) => handleDragOver(e, key)}
                onDragLeave={() =>
                  setDragOverKey((curr) => (curr === key ? null : curr))
                }
                onDrop={(e) => handleDrop(e, key)}
                onDragEnd={handleDragEnd}
                className={`group rounded-md border transition-[border-color,background-color,opacity,box-shadow] duration-150 select-none ${
                  isDragging
                    ? 'opacity-45 bg-[#131D29] border-[#22D3EE]/50'
                    : isDropTarget
                      ? 'bg-[#131D29] border-[#22D3EE] ring-1 ring-[#22D3EE]/50'
                      : isSelected
                        ? 'bg-[#131C26] border-[#22D3EE]/70'
                        : isLocked
                          ? 'bg-[#12151C] border-[#F59E0B]/35'
                          : isCheckedForPng
                            ? 'bg-[#0F161F] border-[#22D3EE]/45'
                            : isVisible
                              ? 'bg-[#0B0D10] border-[#222833] hover:border-[#22D3EE]/50'
                              : 'bg-[#0B0D10]/55 border-[#1A1F2A] opacity-70 hover:opacity-95'
                } ${isLocked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
              >
                <div className="px-2 py-2 flex items-center justify-between gap-1">
                  {/* Left: Export Selection Checkbox + Grip/Lock + Clickable Label */}
                  <input
                    type="checkbox"
                    disabled={!isVisible}
                    checked={isCheckedForPng}
                    onChange={() => onToggleExportSelection(key)}
                    aria-label={`Select ${info.title} for transparent PNG export`}
                    title={
                      isVisible
                        ? `Include ${info.title} in transparent PNG export`
                        : 'Show this layer to export as PNG'
                    }
                    className="accent-[#22D3EE] w-3.5 h-3.5 shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  />

                  <button
                    type="button"
                    onClick={() => onSelectLayer(key)}
                    className="flex items-center gap-1 min-w-0 flex-1 text-left cursor-pointer"
                    title={`Select and jump to ${info.title}`}
                  >
                    {isLocked ? (
                      <Lock
                        className="w-3 h-3 text-[#F59E0B] shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <GripVertical
                        className="w-3.5 h-3.5 text-[#6E788A] group-hover:text-[#22D3EE] shrink-0 transition-colors"
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-mono text-[10px] text-[#6E788A] tabular-nums shrink-0">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-xs font-medium truncate ${
                          !isVisible
                            ? 'text-[#6E788A] line-through'
                            : isSelected
                              ? 'text-[#67E8F9]'
                              : 'text-[#E4E9F1]'
                        }`}
                      >
                        {info.title}
                      </p>
                      <p className="text-[10px] text-[#6E788A] truncate">
                        {isLocked
                          ? !isVisible
                            ? 'Locked · Hidden'
                            : 'Locked on canvas'
                          : !isVisible
                            ? 'Hidden from canvas'
                            : info.getDetail(project)}
                      </p>
                    </div>
                  </button>

                  {/* Right: Quick PNG, Reorder, Visibility, Lock Actions */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      disabled={!isVisible || isExportingPngs}
                      onClick={() => onQuickExportSinglePng(key)}
                      aria-label={`Export ${info.title} as transparent PNG`}
                      title={
                        isVisible
                          ? `Export ${info.title} as transparent PNG`
                          : 'Show section to export PNG'
                      }
                      className="w-5 h-6 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {exportingSingleKey === key ? (
                        <Loader2 className="w-3 h-3 animate-spin text-[#22D3EE]" />
                      ) : (
                        <ImageDown className="w-3 h-3" />
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={!canMoveUp}
                      onClick={() => onNudgeSection(key, -1)}
                      aria-label={`Move ${info.title} up`}
                      title={
                        isLocked
                          ? `Unlock ${info.title} to reorder`
                          : `Move ${info.title} up`
                      }
                      className="w-5 h-6 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-25 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>

                    <button
                      type="button"
                      disabled={!canMoveDown}
                      onClick={() => onNudgeSection(key, 1)}
                      aria-label={`Move ${info.title} down`}
                      title={
                        isLocked
                          ? `Unlock ${info.title} to reorder`
                          : `Move ${info.title} down`
                      }
                      className="w-5 h-6 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-25 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>

                    <button
                      type="button"
                      disabled={isLocked}
                      onClick={() => onToggleVisibility(key)}
                      aria-label={
                        isVisible ? `Hide ${info.title}` : `Show ${info.title}`
                      }
                      aria-pressed={!isVisible}
                      title={
                        isLocked
                          ? `Unlock ${info.title} to change visibility`
                          : isVisible
                            ? `Hide ${info.title}`
                            : `Show ${info.title}`
                      }
                      className={`w-5 h-6 inline-flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ${
                        isVisible
                          ? 'text-[#A0AABB] hover:text-[#67E8F9] hover:bg-[#18212E]'
                          : 'text-[#FCA5A5] bg-[#24161A] hover:bg-[#2F1B21]'
                      }`}
                    >
                      {isVisible ? (
                        <Eye className="w-3 h-3" />
                      ) : (
                        <EyeOff className="w-3 h-3" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleLock(key)}
                      aria-label={
                        isLocked ? `Unlock ${info.title}` : `Lock ${info.title}`
                      }
                      aria-pressed={isLocked}
                      title={
                        isLocked
                          ? `Unlock ${info.title} so it can be hidden or reordered`
                          : `Lock ${info.title} in place`
                      }
                      className={`w-5 h-6 inline-flex items-center justify-center rounded transition-colors cursor-pointer ${
                        isLocked
                          ? 'text-[#F59E0B] bg-[#271F12] hover:bg-[#332816]'
                          : 'text-[#6E788A] hover:text-[#F5F7FA] hover:bg-[#18212E]'
                      }`}
                    >
                      {isLocked ? (
                        <Lock className="w-3 h-3" />
                      ) : (
                        <Unlock className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Pinned Bottom Layer: Footer */}
        <div
          className={`px-2 py-2 rounded-md border flex items-center justify-between gap-1.5 transition-colors ${
            selectedLayer === 'footer'
              ? 'bg-[#131C26] border-[#22D3EE]/70'
              : isFooterChecked
                ? 'bg-[#0F161F] border-[#22D3EE]/40'
                : 'bg-[#0B0D10] border-[#1F2532] hover:border-[#2A3342]'
          }`}
        >
          <input
            type="checkbox"
            checked={isFooterChecked}
            onChange={() => onToggleExportSelection('footer')}
            aria-label="Select Site Footer for transparent PNG export"
            title="Include Site Footer in PNG export"
            className="accent-[#22D3EE] w-3.5 h-3.5 shrink-0 cursor-pointer"
          />
          <button
            type="button"
            onClick={() => onSelectLayer('footer')}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
          >
            <Pin className="w-3 h-3 text-[#6E788A] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#E4E9F1] truncate">
                Site Footer
              </p>
              <p className="text-[10px] text-[#6E788A] truncate">
                Pinned bottom · Brand &amp; address
              </p>
            </div>
          </button>
          <button
            type="button"
            disabled={isExportingPngs}
            onClick={() => onQuickExportSinglePng('footer')}
            aria-label="Export Site Footer as transparent PNG"
            title="Export Site Footer as transparent PNG"
            className="w-6 h-6 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-35 cursor-pointer shrink-0"
          >
            {exportingSingleKey === 'footer' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" />
            ) : (
              <ImageDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Transparent Section PNG Export Dock */}
      <div className="px-3 py-3 border-t border-[#1F2532] bg-[#0D1016] space-y-2">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-semibold text-[#F5F7FA]">
            Transparent PNGs
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSelectAllExportSections}
              className="text-[#67E8F9] hover:underline cursor-pointer"
            >
              All
            </button>
            {visibleExportSelectedCount > 0 && (
              <button
                type="button"
                onClick={onClearExportSections}
                className="text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={isExportingPngs || visibleExportSelectedCount === 0}
            onClick={onQuickExportSelectedPngs}
            className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-40 rounded transition-colors whitespace-nowrap cursor-pointer"
          >
            {isExportingPngs && !exportingSingleKey ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                Exporting...
              </>
            ) : (
              <>
                <ImageDown className="w-3 h-3" aria-hidden="true" />
                Export PNGs ({visibleExportSelectedCount})
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenPngExportModal}
            title="Open Transparent PNG Export studio (preview cutouts, 1×/2× scale, ZIP bundle)"
            aria-label="Open PNG export options and preview"
            className="h-8 px-2 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#67E8F9] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/55 rounded transition-colors cursor-pointer shrink-0"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>

        {pngExportNotice && (
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-1 text-[10px] text-[#34D399]"
          >
            <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{pngExportNotice}</span>
          </p>
        )}
      </div>

      {/* Quick Layer Tree Utilities */}
      <div className="px-3 py-2 border-t border-[#1F2532] bg-[#0B0D10] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {hiddenUnlockedCount > 0 && (
            <button
              type="button"
              onClick={onShowAllSections}
              className="text-[11px] font-medium text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
            >
              Show all
            </button>
          )}
          {lockedCount > 0 && (
            <button
              type="button"
              onClick={onUnlockAllSections}
              className="text-[11px] font-medium text-[#F59E0B] hover:underline whitespace-nowrap cursor-pointer"
            >
              Unlock all
            </button>
          )}
          {hiddenUnlockedCount === 0 && lockedCount === 0 && (
            <span className="text-[10px] text-[#6E788A]">
              Tick layers to export cutouts
            </span>
          )}
        </div>

        {isCustomOrder && (
          <button
            type="button"
            onClick={onResetOrder}
            title="Restore default section order for unlocked sections"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#A0AABB] hover:text-[#67E8F9] whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            Reset order
          </button>
        )}
      </div>
    </aside>
  );
}
