import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Box,
  CheckCircle2,
  Film,
  LayoutTemplate,
  X,
} from 'lucide-react';

export type TransferToastTarget =
  | 'spatial3d'
  | 'videoStage'
  | 'mockup'
  | 'notebook';

export interface TransferToastItem {
  id: number;
  target: TransferToastTarget;
  title: string;
  description: string;
  label?: string;
  thumbnailDataUrl?: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface TransferToastProps {
  toast: TransferToastItem | null;
  onDismiss: () => void;
  onReturnToMediaLab?: () => void;
  onPauseAutoDismiss?: () => void;
  onResumeAutoDismiss?: () => void;
}

const TARGET_META: Record<
  TransferToastTarget,
  { badge: string; icon: typeof Box }
> = {
  spatial3d: {
    badge: 'Spatial & Maps Hub',
    icon: Box,
  },
  videoStage: {
    badge: 'Video Stage',
    icon: Film,
  },
  mockup: {
    badge: 'Site Mockup',
    icon: LayoutTemplate,
  },
  notebook: {
    badge: 'Newsroom Sources',
    icon: BookOpen,
  },
};

export function TransferToast({
  toast,
  onDismiss,
  onReturnToMediaLab,
  onPauseAutoDismiss,
  onResumeAutoDismiss,
}: TransferToastProps) {
  if (!toast) return null;

  const meta = TARGET_META[toast.target];
  const TargetIcon = meta.icon;
  const showMediaReturn = Boolean(
    onReturnToMediaLab && toast.target !== 'notebook'
  );

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={onPauseAutoDismiss}
      onMouseLeave={onResumeAutoDismiss}
      className="fixed top-20 right-4 sm:right-6 z-50 w-[360px] max-w-[calc(100vw-2rem)] bg-[#0E1116]/95 backdrop-blur-md border border-[#22D3EE]/45 rounded-xl shadow-[0_18px_48px_rgba(0,0,0,0.65)] overflow-hidden"
    >
      {/* Top confirmation hairline */}
      <div className="h-0.5 w-full bg-gradient-to-r from-emerald-400 via-[#22D3EE] to-[#67E8F9]" />

      <div className="p-3.5 flex items-start gap-3">
        {toast.thumbnailDataUrl ? (
          <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/15 bg-[#0B0D10] shrink-0">
            <img
              src={toast.thumbnailDataUrl}
              alt={toast.label || toast.title}
              className="w-full h-full object-cover"
            />
            <span className="absolute bottom-0.5 right-0.5 w-4 h-4 rounded-full bg-[#0E1116] flex items-center justify-center">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
            </span>
          </div>
        ) : (
          <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-400/35 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" aria-hidden="true" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[#67E8F9] mb-0.5">
            <TargetIcon className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>{meta.badge}</span>
          </div>
          <p className="text-sm font-semibold text-[#F5F7FA] leading-snug">
            {toast.title}
          </p>
          <p className="text-xs text-[#A3AEBF] mt-0.5 leading-relaxed">
            {toast.description}
          </p>
          {toast.label && (
            <p className="text-[11px] text-[#7D889B] mt-1 truncate font-mono">
              {toast.label}
            </p>
          )}

          {(toast.onAction || showMediaReturn) && (
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              {toast.onAction && toast.actionLabel && (
                <button
                  type="button"
                  onClick={toast.onAction}
                  className="h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                >
                  {toast.actionLabel}
                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
              {showMediaReturn && onReturnToMediaLab && (
                <button
                  type="button"
                  onClick={onReturnToMediaLab}
                  className="h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#67E8F9] bg-[#13161C] border border-[#22D3EE]/35 hover:border-[#22D3EE] rounded-md transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3 h-3" aria-hidden="true" />
                  Back to Media Lab
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] rounded-md hover:bg-white/5 transition-colors shrink-0 cursor-pointer"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
