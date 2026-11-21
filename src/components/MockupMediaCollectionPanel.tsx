import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  Archive,
  Check,
  Download,
  FolderPlus,
  ImagePlus,
  Loader2,
  Trash2,
} from 'lucide-react';
import type {
  MockupMediaAsset,
  MockupMediaCategory,
  SiteMockupProject,
} from '../types';
import {
  downloadSingleMockupAsset,
  type ExportableMockupAsset,
} from '../utils/mockupAssetZip';
import { estimateDataUrlKb, formatStorageKb } from '../utils/imageUpload';

interface MockupMediaCollectionPanelProps {
  project: SiteMockupProject;
  handoverAssets: ExportableMockupAsset[];
  totalMediaKb: number;
  isExportingZip: boolean;
  exportedZipInfo: { filename: string; assetCount: number; totalKb: number } | null;
  zipError: string | null;
  collectionUploadProgress: { current: number; total: number } | null;
  onExportZip: () => void;
  onAddCollectionFiles: (files: File[], category: MockupMediaCategory) => void;
  onRenameAsset: (assetId: string, label: string) => void;
  onChangeAssetCategory: (assetId: string, category: MockupMediaCategory) => void;
  onAssignAssetToSlot: (
    asset: MockupMediaAsset,
    slot: 'logo' | 'hero' | { projectId: string }
  ) => void;
  onDeleteCollectionAsset: (assetId: string) => void;
  onSyncActiveSlotsToCollection: () => void;
}

const CATEGORY_LABELS: Record<MockupMediaCategory, string> = {
  'site-photo': 'Site Photo',
  logo: 'Logo',
  hero: 'Hero',
  project: 'Project',
};

const FILTER_OPTIONS: Array<{ id: 'all' | MockupMediaCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'site-photo', label: 'Site Photos' },
  { id: 'logo', label: 'Logos' },
  { id: 'hero', label: 'Hero' },
  { id: 'project', label: 'Projects' },
];

export function MockupHandoverHeader({
  handoverAssets,
  totalMediaKb,
  isExportingZip,
  exportedZipInfo,
  zipError,
  onExportZip,
}: Pick<
  MockupMediaCollectionPanelProps,
  | 'handoverAssets'
  | 'totalMediaKb'
  | 'isExportingZip'
  | 'exportedZipInfo'
  | 'zipError'
  | 'onExportZip'
>) {
  const assetCount = handoverAssets.length;

  return (
    <div className="p-3 rounded-md bg-[#0B0D10] border border-[#22D3EE]/30 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-[#F5F7FA]">
            Client Handover Asset Pack
          </h3>
          <p className="text-[11px] text-[#8C96A8] mt-0.5 leading-snug">
            Exports logo, hero, project photos, media collection &amp; brand manifest in one ZIP.
          </p>
        </div>
        <span className="font-mono text-[11px] text-[#67E8F9] tabular-nums shrink-0">
          {assetCount} {assetCount === 1 ? 'file' : 'files'} · {formatStorageKb(totalMediaKb)}
        </span>
      </div>

      <button
        type="button"
        disabled={assetCount === 0 || isExportingZip}
        onClick={onExportZip}
        className={`w-full h-9 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
          exportedZipInfo
            ? 'bg-[#132422] text-[#34D399] border border-[#34D399]/60'
            : 'bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318]'
        }`}
      >
        {isExportingZip ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            Packing Handover ZIP...
          </>
        ) : exportedZipInfo ? (
          <>
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            Exported {exportedZipInfo.assetCount} Assets ({formatStorageKb(exportedZipInfo.totalKb)})
          </>
        ) : (
          <>
            <Archive className="w-3.5 h-3.5" aria-hidden="true" />
            Export All Assets (.zip)
          </>
        )}
      </button>

      {assetCount === 0 && (
        <p className="text-[11px] text-[#6E788A]">
          Upload a logo, hero photo, or add site photos below to unlock ZIP export.
        </p>
      )}

      {exportedZipInfo && (
        <p className="font-mono text-[10px] text-[#34D399] truncate">
          Saved {exportedZipInfo.filename}
        </p>
      )}

      {zipError && (
        <p role="alert" className="text-[11px] text-[#FCA5A5]">
          {zipError}
        </p>
      )}
    </div>
  );
}

export function MockupMediaCollectionPanel({
  project,
  collectionUploadProgress,
  onAddCollectionFiles,
  onRenameAsset,
  onChangeAssetCategory,
  onAssignAssetToSlot,
  onDeleteCollectionAsset,
  onSyncActiveSlotsToCollection,
}: Omit<
  MockupMediaCollectionPanelProps,
  'handoverAssets' | 'totalMediaKb' | 'isExportingZip' | 'exportedZipInfo' | 'zipError' | 'onExportZip'
>) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadCategory, setUploadCategory] = useState<MockupMediaCategory>('site-photo');
  const [activeFilter, setActiveFilter] = useState<'all' | MockupMediaCategory>('all');
  const [isDragging, setIsDragging] = useState(false);

  const collection = project.mediaCollection || [];
  const collectionDataUrls = new Set(collection.map((item) => item.dataUrl));

  // Count active canvas slots not yet archived in the reusable project collection
  const unsavedSlotCount =
    (project.brand.logoDataUrl && !collectionDataUrls.has(project.brand.logoDataUrl) ? 1 : 0) +
    (project.hero.photoDataUrl && !collectionDataUrls.has(project.hero.photoDataUrl) ? 1 : 0) +
    project.projects.filter(
      (p) => Boolean(p.photoDataUrl) && !collectionDataUrls.has(p.photoDataUrl as string)
    ).length;

  const filteredCollection =
    activeFilter === 'all'
      ? collection
      : collection.filter((item) => item.category === activeFilter);

  function getActiveSlotSummary(dataUrl: string): string | null {
    const matches: string[] = [];
    if (project.brand.logoDataUrl === dataUrl) matches.push('Logo');
    if (project.hero.photoDataUrl === dataUrl) matches.push('Hero');
    project.projects.forEach((prj, idx) => {
      if (prj.photoDataUrl === dataUrl) {
        matches.push(`Project ${idx + 1}`);
      }
    });
    return matches.length > 0 ? matches.join(', ') : null;
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length === 0) return;
    onAddCollectionFiles(files, uploadCategory);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length > 0) {
      onAddCollectionFiles(files, uploadCategory);
    }
  }

  const isUploadingBatch = Boolean(collectionUploadProgress);

  return (
    <div className="pt-4 border-t border-[#1F2532] space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-[#F5F7FA]">
            Project Media Collection ({collection.length})
          </h4>
          <p className="text-[11px] text-[#8C96A8] mt-0.5 leading-snug">
            Store extra logos &amp; site photos for this project, assign to slots, or bundle in ZIP.
          </p>
        </div>
        {unsavedSlotCount > 0 && (
          <button
            type="button"
            onClick={onSyncActiveSlotsToCollection}
            title="Copy currently slotted Logo, Hero, and Project photos into this project's reusable media collection"
            className="h-7 px-2 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FolderPlus className="w-3 h-3" aria-hidden="true" />
            Save Slots ({unsavedSlotCount})
          </button>
        )}
      </div>

      {/* Multi-file Dropzone + Category Target */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-md border border-dashed p-3 transition-colors space-y-2.5 ${
          isDragging
            ? 'border-[#22D3EE] bg-[#18212E]/70'
            : 'border-[#2A3342] bg-[#0B0D10]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleInputChange}
          className="hidden"
        />

        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="media-collection-category"
            className="text-[11px] font-medium text-[#A0AABB]"
          >
            Upload folder
          </label>
          <select
            id="media-collection-category"
            value={uploadCategory}
            onChange={(e) => setUploadCategory(e.target.value as MockupMediaCategory)}
            className="h-7 px-2 text-[11px] text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] focus:border-[#22D3EE] rounded"
          >
            <option value="site-photo">04 · Site Photos</option>
            <option value="logo">01 · Logo Variant</option>
            <option value="hero">02 · Hero Candidate</option>
            <option value="project">03 · Project Photo</option>
          </select>
        </div>

        <button
          type="button"
          disabled={isUploadingBatch}
          onClick={() => fileInputRef.current?.click()}
          className="w-full h-9 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] hover:bg-[#18212E] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
        >
          {isUploadingBatch && collectionUploadProgress ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" aria-hidden="true" />
              Compressing {collectionUploadProgress.current}/{collectionUploadProgress.total}...
            </>
          ) : (
            <>
              <ImagePlus className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Add Site Photos or Logos (Multi-Select)
            </>
          )}
        </button>

        <p className="text-[10px] text-[#6E788A] text-center">
          Drop multiple JPG, PNG, or WebP files here — auto-compressed via hidden canvas.
        </p>
      </div>

      {/* Category Filter Strip */}
      {collection.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {FILTER_OPTIONS.map((opt) => {
            const count =
              opt.id === 'all'
                ? collection.length
                : collection.filter((item) => item.category === opt.id).length;
            if (opt.id !== 'all' && count === 0) return null;
            const active = activeFilter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setActiveFilter(opt.id)}
                className={`h-7 px-2 text-[11px] font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]/50'
                    : 'bg-[#0B0D10] text-[#8C96A8] border-[#1F2532] hover:text-[#F5F7FA]'
                }`}
              >
                {opt.label}{' '}
                <span className="font-mono text-[10px] tabular-nums opacity-80">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Collection Cards */}
      {collection.length === 0 ? (
        <p className="text-[11px] text-[#6E788A] leading-relaxed">
          No extra assets in this project&apos;s collection yet. Upload site photos above or save active canvas slots so you can swap photos freely and hand over the full folder as a ZIP.
        </p>
      ) : filteredCollection.length === 0 ? (
        <p className="text-[11px] text-[#6E788A]">
          No assets in this category yet.
        </p>
      ) : (
        <div className="space-y-2.5">
          {filteredCollection.map((asset) => {
            const sizeKb = asset.sizeKb ?? estimateDataUrlKb(asset.dataUrl);
            const activeSlotLabel = getActiveSlotSummary(asset.dataUrl);
            return (
              <div
                key={asset.id}
                className="p-2.5 rounded-md bg-[#0B0D10] border border-[#222833] space-y-2"
              >
                <div className="flex items-start gap-2.5">
                  <div className="w-16 h-12 rounded border border-[#1F2532] bg-[#13161C] overflow-hidden shrink-0 flex items-center justify-center">
                    <img
                      src={asset.dataUrl}
                      alt={asset.label}
                      className={
                        asset.category === 'logo'
                          ? 'max-w-full max-h-full object-contain p-1'
                          : 'w-full h-full object-cover'
                      }
                    />
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <input
                      type="text"
                      aria-label="Asset filename label"
                      value={asset.label}
                      onChange={(e) => onRenameAsset(asset.id, e.target.value)}
                      placeholder="Asset label (used in ZIP)"
                      className="w-full h-7 px-2 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] focus:border-[#22D3EE] rounded"
                    />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono tabular-nums text-[#8C96A8]">
                      <span>{formatStorageKb(sizeKb)}</span>
                      {asset.width && asset.height && (
                        <span>
                          {asset.width}×{asset.height}
                        </span>
                      )}
                      {activeSlotLabel && (
                        <span className="text-[#67E8F9]">
                          Active: {activeSlotLabel}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => downloadSingleMockupAsset(asset.dataUrl, asset.label)}
                      title={`Download ${asset.label}`}
                      aria-label={`Download ${asset.label}`}
                      className="w-7 h-7 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteCollectionAsset(asset.id)}
                      title={`Remove ${asset.label} from collection`}
                      aria-label={`Remove ${asset.label} from collection`}
                      className="w-7 h-7 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#FCA5A5] hover:bg-[#24161A] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Folder + Quick Slot Assignment Row */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1.5 border-t border-[#1A1F2B]">
                  <select
                    aria-label={`Folder category for ${asset.label}`}
                    value={asset.category}
                    onChange={(e) =>
                      onChangeAssetCategory(asset.id, e.target.value as MockupMediaCategory)
                    }
                    className="h-6 px-1.5 text-[10px] text-[#A0AABB] bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded"
                  >
                    {(Object.keys(CATEGORY_LABELS) as MockupMediaCategory[]).map((cat) => (
                      <option key={cat} value={cat}>
                        {CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>

                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onAssignAssetToSlot(asset, 'logo')}
                      className="h-6 px-1.5 text-[10px] font-medium text-[#A0AABB] hover:text-[#67E8F9] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/50 rounded whitespace-nowrap cursor-pointer"
                    >
                      Set Logo
                    </button>
                    <button
                      type="button"
                      onClick={() => onAssignAssetToSlot(asset, 'hero')}
                      className="h-6 px-1.5 text-[10px] font-medium text-[#A0AABB] hover:text-[#67E8F9] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/50 rounded whitespace-nowrap cursor-pointer"
                    >
                      Set Hero
                    </button>
                    {project.projects.length > 0 && (
                      <select
                        aria-label={`Assign ${asset.label} to project card`}
                        defaultValue=""
                        onChange={(e) => {
                          const targetProjectId = e.target.value;
                          e.target.value = '';
                          if (targetProjectId) {
                            onAssignAssetToSlot(asset, { projectId: targetProjectId });
                          }
                        }}
                        className="h-6 px-1.5 text-[10px] font-medium text-[#A0AABB] hover:text-[#67E8F9] bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded cursor-pointer"
                      >
                        <option value="">→ Project...</option>
                        {project.projects.map((prj, idx) => (
                          <option key={prj.id} value={prj.id}>
                            {String(idx + 1).padStart(2, '0')}. {prj.title.slice(0, 18)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
