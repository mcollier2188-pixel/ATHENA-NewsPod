import { useEffect, useState } from 'react';
import {
  Archive,
  Check,
  Download,
  Eye,
  ImageDown,
  Loader2,
  X,
} from 'lucide-react';
import type { MockupSectionKey, SiteMockupProject } from '../types';
import {
  CANVAS_SECTION_EXPORT_SPECS,
  captureSectionAsTransparentPng,
  downloadCapturedSectionPngsAsZip,
  downloadCapturedSectionPngsIndividually,
  triggerPngBlobDownload,
  type CapturedSectionPng,
  type ExportableCanvasSectionKey,
} from '../utils/sectionPngExport';
import { formatStorageKb } from '../utils/imageUpload';

interface SectionPngExportModalProps {
  isOpen: boolean;
  project: SiteMockupProject;
  orderedSections: MockupSectionKey[];
  selectedKeys: ExportableCanvasSectionKey[];
  onToggleSelectKey: (key: ExportableCanvasSectionKey) => void;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onUnhideSection: (key: MockupSectionKey) => void;
  onClose: () => void;
}

export function SectionPngExportModal({
  isOpen,
  project,
  orderedSections,
  selectedKeys,
  onToggleSelectKey,
  onSelectAllVisible,
  onClearSelection,
  onUnhideSection,
  onClose,
}: SectionPngExportModalProps) {
  const [pixelRatio, setPixelRatio] = useState<1 | 2>(2);
  const [transparentBackdrop, setTransparentBackdrop] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const [capturedAssets, setCapturedAssets] = useState<CapturedSectionPng[]>([]);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clean up object URLs whenever captured previews change or unmount
  useEffect(() => {
    return () => {
      capturedAssets.forEach((asset) => URL.revokeObjectURL(asset.previewUrl));
    };
  }, [capturedAssets]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setStatusNotice(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const allOrderedCanvasKeys: ExportableCanvasSectionKey[] = [
    'hero',
    ...orderedSections,
    'footer',
  ];

  function isKeyVisible(key: ExportableCanvasSectionKey): boolean {
    if (key === 'hero' || key === 'footer') return true;
    return Boolean(project.sectionVisibility[key]);
  }

  const visibleSelectedKeys = allOrderedCanvasKeys.filter(
    (key) => isKeyVisible(key) && selectedKeys.includes(key)
  );

  async function renderSelectedSections(
    mode: 'preview' | 'download-individual' | 'download-zip'
  ) {
    if (visibleSelectedKeys.length === 0) {
      setError('Select at least one visible section to export as a transparent PNG.');
      return;
    }

    setError(null);
    setStatusNotice(null);
    setIsCapturing(true);

    const rendered: CapturedSectionPng[] = [];
    const failed: string[] = [];

    try {
      for (let idx = 0; idx < visibleSelectedKeys.length; idx++) {
        const key = visibleSelectedKeys[idx];
        const spec = CANVAS_SECTION_EXPORT_SPECS[key];
        setCaptureProgress({
          current: idx + 1,
          total: visibleSelectedKeys.length,
          label: spec.label,
        });
        try {
          const asset = await captureSectionAsTransparentPng(key, {
            brandName: project.brand.name,
            pixelRatio,
            transparentBackdrop,
          });
          rendered.push(asset);
        } catch (err) {
          failed.push(
            `${spec.label}: ${err instanceof Error ? err.message : 'capture failed'}`
          );
        }
      }

      if (rendered.length > 0) {
        setCapturedAssets((prev) => {
          prev.forEach((old) => URL.revokeObjectURL(old.previewUrl));
          return rendered;
        });

        if (mode === 'download-individual') {
          await downloadCapturedSectionPngsIndividually(rendered);
          setStatusNotice(
            `Exported ${rendered.length} individual transparent PNG${
              rendered.length === 1 ? '' : 's'
            }.`
          );
        } else if (mode === 'download-zip') {
          const zipResult = await downloadCapturedSectionPngsAsZip(
            rendered,
            project.brand.name
          );
          setStatusNotice(
            `Saved ${zipResult.filename} (${rendered.length} PNGs · ${formatStorageKb(
              zipResult.totalKb
            )}).`
          );
        } else {
          setStatusNotice(
            `Rendered ${rendered.length} preview${
              rendered.length === 1 ? '' : 's'
            } — inspect transparency below or download individually.`
          );
        }
      }

      if (failed.length > 0) {
        setError(failed.join(' · '));
      }
    } finally {
      setIsCapturing(false);
      setCaptureProgress(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-png-export-title"
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-[#13161C] border border-[#22D3EE]/45 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#1F2532] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ImageDown className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2
                id="section-png-export-title"
                className="text-base font-semibold text-[#F5F7FA] truncate"
              >
                Export Sections as Transparent PNGs
              </h2>
              <p className="text-[11px] text-[#8C96A8]">
                Select canvas sections to capture as individual RGBA PNG cutouts for custom layouts.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close section PNG exporter"
            className="w-8 h-8 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#F5F7FA] rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {/* Section Picker + Capture Settings */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            {/* Left: Section Checklist */}
            <div className="md:col-span-7 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#F5F7FA]">
                  Canvas Sections ({visibleSelectedKeys.length} selected)
                </span>
                <div className="flex items-center gap-2.5 text-[11px]">
                  <button
                    type="button"
                    onClick={onSelectAllVisible}
                    className="text-[#67E8F9] hover:underline cursor-pointer"
                  >
                    Select visible
                  </button>
                  <button
                    type="button"
                    onClick={onClearSelection}
                    className="text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                {allOrderedCanvasKeys.map((key, idx) => {
                  const spec = CANVAS_SECTION_EXPORT_SPECS[key];
                  const visible = isKeyVisible(key);
                  const checked = visible && selectedKeys.includes(key);
                  const isLocked =
                    key !== 'hero' &&
                    key !== 'footer' &&
                    Boolean(project.lockedSections?.[key]);

                  return (
                    <div
                      key={key}
                      className={`px-3 py-2 rounded-md border flex items-center justify-between gap-2 transition-colors ${
                        checked
                          ? 'bg-[#131C26] border-[#22D3EE]/60'
                          : visible
                            ? 'bg-[#0B0D10] border-[#222833] hover:border-[#2A3342]'
                            : 'bg-[#0B0D10]/55 border-[#1B202B] opacity-70'
                      }`}
                    >
                      <label
                        className={`flex items-center gap-2.5 min-w-0 flex-1 ${
                          visible ? 'cursor-pointer' : 'cursor-not-allowed'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={!visible}
                          checked={checked}
                          onChange={() => onToggleSelectKey(key)}
                          className="accent-[#22D3EE] w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <span className="font-mono text-[10px] text-[#6E788A] tabular-nums shrink-0">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span
                          className={`text-xs font-medium truncate ${
                            visible ? 'text-[#F5F7FA]' : 'text-[#6E788A] line-through'
                          }`}
                        >
                          {spec.label}
                        </span>
                      </label>

                      {!visible ? (
                        <button
                          type="button"
                          disabled={isLocked}
                          onClick={() => {
                            if (key !== 'hero' && key !== 'footer') {
                              onUnhideSection(key);
                            }
                          }}
                          title={
                            isLocked
                              ? 'Unlock this layer to make it visible'
                              : `Show ${spec.label} on canvas so it can be exported`
                          }
                          className="text-[11px] font-medium text-[#67E8F9] hover:underline disabled:text-[#6E788A] disabled:no-underline disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >
                          {isLocked ? 'Hidden · Locked' : 'Show layer'}
                        </button>
                      ) : (
                        <span className="font-mono text-[10px] text-[#6E788A] shrink-0">
                          .png
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Output Options */}
            <div className="md:col-span-5 space-y-3.5 p-3.5 rounded-md bg-[#0B0D10] border border-[#222833]">
              <div>
                <span className="block text-xs font-semibold text-[#F5F7FA] mb-1.5">
                  Export Resolution
                </span>
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#13161C] border border-[#222833] rounded-md">
                  {([1, 2] as const).map((scale) => (
                    <button
                      key={scale}
                      type="button"
                      onClick={() => setPixelRatio(scale)}
                      className={`h-8 text-xs font-medium rounded transition-colors cursor-pointer ${
                        pixelRatio === scale
                          ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                          : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                      }`}
                    >
                      {scale === 2 ? '2× Retina' : '1× Standard'}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={transparentBackdrop}
                  onChange={(e) => setTransparentBackdrop(e.target.checked)}
                  className="accent-[#22D3EE] w-4 h-4 mt-0.5 shrink-0 cursor-pointer"
                />
                <span className="space-y-0.5">
                  <span className="block text-xs font-semibold text-[#F5F7FA]">
                    Transparent section backdrop
                  </span>
                  <span className="block text-[11px] text-[#8C96A8] leading-snug">
                    Strips outer section background &amp; borders for clean RGBA cutouts while preserving cards, text, and buttons.
                  </span>
                </span>
              </label>

              <div className="pt-2 border-t border-[#1F2532] space-y-2">
                <button
                  type="button"
                  disabled={isCapturing || visibleSelectedKeys.length === 0}
                  onClick={() => renderSelectedSections('download-individual')}
                  className="w-full h-9 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isCapturing && captureProgress ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      Capturing {captureProgress.current}/{captureProgress.total}...
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      Export Individual PNGs ({visibleSelectedKeys.length})
                    </>
                  )}
                </button>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={isCapturing || visibleSelectedKeys.length === 0}
                    onClick={() => renderSelectedSections('preview')}
                    className="h-8 px-2.5 inline-flex items-center justify-center gap-1 text-[11px] font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-45 rounded whitespace-nowrap cursor-pointer"
                  >
                    <Eye className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                    Preview Cutouts
                  </button>

                  <button
                    type="button"
                    disabled={isCapturing || visibleSelectedKeys.length < 2}
                    onClick={() => renderSelectedSections('download-zip')}
                    title="Download all selected transparent section PNGs inside one ZIP"
                    className="h-8 px-2.5 inline-flex items-center justify-center gap-1 text-[11px] font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-40 rounded whitespace-nowrap cursor-pointer"
                  >
                    <Archive className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                    Bundle ZIP
                  </button>
                </div>
              </div>
            </div>
          </div>

          {statusNotice && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 text-xs text-[#34D399]"
            >
              <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {statusNotice}
            </p>
          )}

          {error && (
            <p role="alert" className="text-xs text-[#FCA5A5]">
              {error}
            </p>
          )}

          {/* Rendered Transparent PNG Cutout Previews */}
          {capturedAssets.length > 0 && (
            <div className="pt-4 border-t border-[#1F2532] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-[#F5F7FA]">
                    Rendered PNG Assets ({capturedAssets.length})
                  </h3>
                  <p className="text-[11px] text-[#8C96A8]">
                    Checkerboard shows transparent alpha regions ready for layout compositing.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => downloadCapturedSectionPngsIndividually(capturedAssets)}
                    className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded whitespace-nowrap cursor-pointer"
                  >
                    <Download className="w-3 h-3" aria-hidden="true" />
                    Download All PNGs
                  </button>
                  {capturedAssets.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        downloadCapturedSectionPngsAsZip(
                          capturedAssets,
                          project.brand.name
                        )
                      }
                      className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#D5DCE6] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded whitespace-nowrap cursor-pointer"
                    >
                      <Archive className="w-3 h-3" aria-hidden="true" />
                      Save ZIP
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {capturedAssets.map((asset) => (
                  <div
                    key={asset.filename}
                    className="rounded-md border border-[#222833] bg-[#0B0D10] overflow-hidden flex flex-col"
                  >
                    <div className="png-checkerboard p-3 h-36 flex items-center justify-center overflow-hidden border-b border-[#1F2532]">
                      <img
                        src={asset.previewUrl}
                        alt={`${asset.label} transparent PNG preview`}
                        className="max-w-full max-h-full object-contain drop-shadow-sm"
                      />
                    </div>
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#F5F7FA] truncate">
                          {asset.label}
                        </p>
                        <p className="font-mono text-[10px] text-[#8C96A8] tabular-nums truncate">
                          {asset.width && asset.height
                            ? `${asset.width}×${asset.height} · `
                            : ''}
                          {formatStorageKb(asset.sizeKb)} · PNG
                          {asset.transparentBackdrop ? ' alpha' : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          triggerPngBlobDownload(asset.blob, asset.filename)
                        }
                        className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Download className="w-3 h-3" aria-hidden="true" />
                        PNG
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
