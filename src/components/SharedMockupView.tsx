import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Loader2,
  Monitor,
  Smartphone,
  Tablet,
} from 'lucide-react';
import type { MockupViewport, SharedMockupManifest } from '../types';
import { fetchSharedMockup } from '../services/api';
import {
  fetchPublicShareFromFirestore,
  firestoreDocToSharedMockupManifest,
} from '../services/firestorePublicShares';
import { MockupPreviewCanvas } from './MockupPreviewCanvas';

interface SharedMockupViewProps {
  shareId: string;
  onExit: () => void;
}

export function SharedMockupView({ shareId, onExit }: SharedMockupViewProps) {
  const [manifest, setManifest] = useState<SharedMockupManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [viewport, setViewport] = useState<MockupViewport>('desktop');
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpired(false);

    fetchSharedMockup(shareId)
      .then((res) => {
        if (!cancelled) {
          setManifest(res.share);
        }
      })
      .catch(async (err: Error & { expired?: boolean }) => {
        if (cancelled) return;
        if (!err.expired) {
          const fsDoc = await fetchPublicShareFromFirestore(shareId);
          if (!cancelled && fsDoc && fsDoc.kind === 'mockup') {
            setManifest(firestoreDocToSharedMockupManifest(fsDoc));
            return;
          }
        }
        if (!cancelled) {
          setExpired(Boolean(err.expired));
          setError(err.message || 'Could not load this website preview.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  async function handleCopyCurrentUrl() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Ignore clipboard restrictions
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B0D10] text-[#F5F7FA] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-sm text-[#A0AABB]">
          <Loader2 className="w-5 h-5 text-[#22D3EE] animate-spin" aria-hidden="true" />
          Loading website mockup preview...
        </div>
      </div>
    );
  }

  if (error || !manifest) {
    return (
      <div className="min-h-screen bg-[#0B0D10] text-[#F5F7FA] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#13161C] border border-[#222833] rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2.5 text-[#FCA5A5]">
            <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
            <h1 className="text-base font-semibold text-[#F5F7FA]">
              {expired ? 'Preview Link Expired' : 'Preview Unavailable'}
            </h1>
          </div>
          <p className="text-sm text-[#A0AABB] leading-relaxed">
            {error || 'This website preview link could not be found.'}
          </p>
          <button
            type="button"
            onClick={onExit}
            className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Back to Studio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#F5F7FA] flex flex-col">
      {/* Quiet Client Review Header */}
      <div className="border-b border-[#1F2532] bg-[#0E1116] px-4 sm:px-6 py-2.5">
        <div className="max-w-[1280px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <button
              type="button"
              onClick={onExit}
              className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              Studio
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-[#F5F7FA] font-semibold truncate">
                <span className="truncate">{manifest.project.brand.name}</span>
                <span aria-hidden="true" className="text-[#4B5565]">
                  ·
                </span>
                <span className="text-[#8C96A8] font-normal">Client Preview</span>
              </div>
              {manifest.note && (
                <p className="text-xs text-[#67E8F9] truncate mt-0.5">{manifest.note}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono text-[#8C96A8] tabular-nums">
              <Clock className="w-3 h-3" aria-hidden="true" />
              Expires {new Date(manifest.expiresAt).toLocaleDateString()}
            </span>

            <button
              type="button"
              onClick={handleCopyCurrentUrl}
              className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md whitespace-nowrap cursor-pointer"
            >
              {copiedUrl ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34D399]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-[#22D3EE]" />
                  Copy Link
                </>
              )}
            </button>

            <div
              role="group"
              aria-label="Preview viewport size"
              className="hidden md:inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#222833] rounded-md"
            >
              {(
                [
                  { id: 'desktop', icon: Monitor, label: 'Desktop view' },
                  { id: 'tablet', icon: Tablet, label: 'Tablet view' },
                  { id: 'mobile', icon: Smartphone, label: 'Mobile view' },
                ] as const
              ).map((vp) => {
                const Icon = vp.icon;
                const active = viewport === vp.id;
                return (
                  <button
                    key={vp.id}
                    type="button"
                    aria-label={vp.label}
                    aria-pressed={active}
                    onClick={() => setViewport(vp.id)}
                    className={`w-7 h-7 inline-flex items-center justify-center rounded transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Edge-to-edge on mobile phones, framed cleanly on desktop */}
      <main className="flex-1 p-0 sm:p-6">
        <div className="max-w-[1280px] mx-auto">
          <MockupPreviewCanvas project={manifest.project} viewport={viewport} />
        </div>
      </main>
    </div>
  );
}
