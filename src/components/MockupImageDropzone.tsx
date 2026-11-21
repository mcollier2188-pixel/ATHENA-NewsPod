import { useId, useState, type ChangeEvent, type DragEvent } from 'react';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { estimateDataUrlKb, formatStorageKb } from '../utils/imageUpload';

export interface UploadCompressionMeta {
  originalSizeKb: number;
  sizeKb: number;
  savedPercent: number;
  width: number;
  height: number;
}

interface MockupImageDropzoneProps {
  label: string;
  helperText?: string;
  variant: 'logo' | 'photo';
  dataUrl?: string;
  isCompressing?: boolean;
  compressionMeta?: UploadCompressionMeta | null;
  onSelectFile: (file: File) => void;
  onRemove: () => void;
}

export function MockupImageDropzone({
  label,
  helperText,
  variant,
  dataUrl,
  isCompressing = false,
  compressionMeta,
  onSelectFile,
  onRemove,
}: MockupImageDropzoneProps) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      onSelectFile(file);
    }
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!isCompressing) setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (isCompressing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onSelectFile(file);
    }
  }

  const storedKb = estimateDataUrlKb(dataUrl);
  const statsLabel = compressionMeta
    ? `${formatStorageKb(compressionMeta.originalSizeKb)} → ${formatStorageKb(compressionMeta.sizeKb)} (${compressionMeta.savedPercent}% smaller) · ${compressionMeta.width}×${compressionMeta.height}`
    : `${formatStorageKb(storedKb)} compressed`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[#F5F7FA]">{label}</span>
        {helperText && (
          <span className="text-[11px] text-[#6E788A] truncate">{helperText}</span>
        )}
      </div>

      {dataUrl ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-[#0B0D10] border rounded-md overflow-hidden transition-colors ${
            isDragging ? 'border-[#22D3EE]' : 'border-[#2A3342]'
          }`}
        >
          {variant === 'logo' ? (
            <div className="p-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-10 w-20 bg-white/95 rounded flex items-center justify-center p-1.5 shrink-0">
                  <img
                    src={dataUrl}
                    alt={`${label} preview`}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-[#A0AABB] tabular-nums truncate">
                    {statsLabel}
                  </p>
                  <p className="text-[10px] text-[#6E788A]">
                    Drop new file to replace
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <label
                  htmlFor={inputId}
                  className="h-7 px-2.5 inline-flex items-center text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded cursor-pointer whitespace-nowrap"
                >
                  {isCompressing ? '...' : 'Replace'}
                </label>
                <button
                  type="button"
                  onClick={onRemove}
                  aria-label={`Remove ${label}`}
                  className="h-7 w-7 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="aspect-[16/9] w-full overflow-hidden bg-[#13161C]">
                <img
                  src={dataUrl}
                  alt={`${label} preview`}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="px-2.5 py-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-[#A0AABB] tabular-nums truncate">
                  {statsLabel}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <label
                    htmlFor={inputId}
                    className="h-7 px-2.5 inline-flex items-center text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded cursor-pointer whitespace-nowrap"
                  >
                    {isCompressing ? '...' : 'Replace'}
                  </label>
                  <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Remove ${label}`}
                    className="h-7 w-7 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <label
          htmlFor={inputId}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-1.5 px-3 py-4 text-center rounded-md border border-dashed cursor-pointer transition-colors ${
            isDragging
              ? 'border-[#22D3EE] bg-[#18212E]/60 text-[#F5F7FA]'
              : 'border-[#2A3342] bg-[#0B0D10] text-[#A0AABB] hover:border-[#22D3EE]/60 hover:text-[#F5F7FA]'
          }`}
        >
          {isCompressing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" aria-hidden="true" />
              <span className="text-xs font-medium text-[#67E8F9]">
                Compressing image on canvas...
              </span>
            </>
          ) : (
            <>
              {isDragging ? (
                <Upload className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              ) : (
                <ImagePlus className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              )}
              <span className="text-xs font-medium">
                {isDragging
                  ? 'Drop image to compress & apply'
                  : variant === 'logo'
                    ? 'Drop logo or browse device'
                    : 'Drop site photo or pick from device'}
              </span>
              <span className="text-[10px] text-[#6E788A]">
                {variant === 'logo'
                  ? 'PNG, WebP, or JPG · auto-scaled for crisp header display'
                  : 'Phone camera or PC · auto-compressed for fast offline saving'}
              </span>
            </>
          )}
        </label>
      )}

      <input
        id={inputId}
        type="file"
        accept="image/*"
        disabled={isCompressing}
        onChange={handleInputChange}
        className="sr-only"
      />
    </div>
  );
}
