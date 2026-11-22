import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Box,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
  GripVertical,
  History,
  ImageDown,
  ImagePlus,
  Layers,
  Loader2,
  Lock,
  Monitor,
  Palette,
  PenLine,
  Pipette,
  Plus,
  Printer,
  RotateCcw,
  Share2,
  Smartphone,
  Tablet,
  Trash2,
  Undo2,
  Unlock,
  Wand2,
} from 'lucide-react';
import type {
  MockupCanvasMode,
  MockupFontMood,
  MockupFontPairing,
  MockupMediaAsset,
  MockupMediaCategory,
  MockupSectionKey,
  MockupSnapshot,
  MockupViewport,
  SiteMockupProject,
} from '../types';
import {
  createStarterMockup,
  DEFAULT_SECTION_ORDER,
  normalizeSectionOrder,
  PALETTE_PRESETS,
} from '../data/defaultMockup';
import {
  analyzeWebsiteForMockup,
  extractWebsiteBrandColors,
  rewriteMockupSection,
  suggestWebsiteFontPairings,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import {
  deleteDbMockup,
  fetchDbMockupById,
  fetchDbMockups,
  saveDbMockup,
  updateDbMockupMeta,
  type DbSavedMockupSummary,
} from '../services/suiteApi';
import {
  computeMockupContentHash,
  countMockupUniqueAssets,
  normalizeRestoredMockupProject,
} from '../utils/mockupVersionHash';
import { useFirestoreSiteMockupSync } from '../hooks/useFirestoreSiteMockupSync';
import { buildStandaloneMockupHtml } from '../utils/mockupHtmlExport';
import {
  DEFAULT_PAIRING_BY_MOOD,
  ensureGoogleFontsLoaded,
  resolveActiveFontPairing,
} from '../utils/googleFonts';
import {
  autoFixMockupPalette,
  evaluateMockupContrast,
  formatContrastRatio,
} from '../utils/colorContrast';
import {
  compressImageFile,
  estimateDataUrlKb,
} from '../utils/imageUpload';
import {
  collectProjectAssets,
  exportMockupAssetsZip,
} from '../utils/mockupAssetZip';
import {
  captureSectionAsTransparentPng,
  downloadCapturedSectionPngsIndividually,
  triggerPngBlobDownload,
  type ExportableCanvasSectionKey,
} from '../utils/sectionPngExport';
import { copyHexToClipboard } from '../utils/clipboard';
import { MockupPreviewCanvas } from './MockupPreviewCanvas';
import { ShareMockupModal } from './ShareMockupModal';
import { MockupPitchSheetModal } from './MockupPitchSheetModal';
import { SectionPngExportModal } from './SectionPngExportModal';
import {
  MockupImageDropzone,
  type UploadCompressionMeta,
} from './MockupImageDropzone';
import {
  MockupHandoverHeader,
  MockupMediaCollectionPanel,
} from './MockupMediaCollectionPanel';
import {
  MockupLayerManagerSidebar,
  type MockupLayerTarget,
} from './MockupLayerManagerSidebar';
import { MockupVersionHistorySidebar } from './MockupVersionHistorySidebar';
import { MockupTypographyPanel } from './MockupTypographyPanel';

interface SiteMockupViewProps {
  onOpenSharedMockup?: (shareId: string) => void;
  onPreviewIn3DDevices?: (project: SiteMockupProject) => void;
  autoOpenPitchSheet?: boolean;
  onAutoOpenPitchSheetHandled?: () => void;
}

const STORAGE_SNAPSHOTS_KEY = 'dispatch_site_mockup_snapshots_v1';

type InspectorTab =
  | 'brand'
  | 'typography'
  | 'media'
  | 'hero'
  | 'services'
  | 'proof'
  | 'contact'
  | 'notes';

function loadStoredSnapshots(): MockupSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MockupSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function SiteMockupView({
  onOpenSharedMockup,
  onPreviewIn3DDevices,
  autoOpenPitchSheet,
  onAutoOpenPitchSheetHandled,
}: SiteMockupViewProps) {
  const {
    project,
    setProject,
    updateProject,
    syncStatus,
    syncError,
    forceSyncNow,
  } = useFirestoreSiteMockupSync();
  const [snapshots, setSnapshots] = useState<MockupSnapshot[]>(() => loadStoredSnapshots());
  const [undoProject, setUndoProject] = useState<SiteMockupProject | null>(null);

  // Import & brand color extraction controls
  const [urlInput, setUrlInput] = useState(() => project.sourceUrl || '');
  const lastSyncedSourceUrlRef = useRef(project.sourceUrl || '');
  useEffect(() => {
    const nextUrl = project.sourceUrl || '';
    if (nextUrl !== lastSyncedSourceUrlRef.current) {
      lastSyncedSourceUrlRef.current = nextUrl;
      setUrlInput(nextUrl);
    }
  }, [project.sourceUrl]);
  const [pasteNotesOpen, setPasteNotesOpen] = useState(false);
  const [rawNotesInput, setRawNotesInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // Gemini Brand Swatch Library controls
  const [isExtractingColors, setIsExtractingColors] = useState(false);
  const [colorExtractError, setColorExtractError] = useState<string | null>(null);
  const [swatchApplyTarget, setSwatchApplyTarget] = useState<'primary' | 'accent' | 'copy'>('primary');
  const [suggestedPair, setSuggestedPair] = useState<{
    primary: string;
    accent: string;
    canvasMode: MockupCanvasMode;
  } | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [appliedSwatchFeedback, setAppliedSwatchFeedback] = useState<{
    hex: string;
    slot: 'primary' | 'accent' | 'copy';
    copied: boolean;
    seq: number;
  } | null>(null);
  const [appliedPairFeedback, setAppliedPairFeedback] = useState<{
    id: string;
    label: string;
    seq: number;
  } | null>(null);
  const [flashedSlots, setFlashedSlots] = useState<{
    primary: boolean;
    accent: boolean;
    seq: number;
  } | null>(null);
  const swatchFeedbackTimerRef = useRef<number | null>(null);
  const pairFeedbackTimerRef = useRef<number | null>(null);
  const slotFlashTimerRef = useRef<number | null>(null);
  const copiedHexTimerRef = useRef<number | null>(null);

  // Typography panel & Google Font pairing suggestions
  const [isSuggestingFonts, setIsSuggestingFonts] = useState(false);
  const [fontSuggestError, setFontSuggestError] = useState<string | null>(null);
  const [detectedSiteFonts, setDetectedSiteFonts] = useState<string[]>([]);
  const [appliedPairingFeedback, setAppliedPairingFeedback] = useState<{
    id: string;
    name: string;
    seq: number;
  } | null>(null);
  const pairingFeedbackTimerRef = useRef<number | null>(null);

  // Hidden canvas & image upload feedback
  const compressionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [compressionMetaBySlot, setCompressionMetaBySlot] = useState<
    Record<string, UploadCompressionMeta>
  >({});
  const [collectionUploadProgress, setCollectionUploadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [exportedZipInfo, setExportedZipInfo] = useState<{
    filename: string;
    assetCount: number;
    totalKb: number;
  } | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipFeedbackTimerRef = useRef<number | null>(null);

  // Workspace view controls
  const [viewport, setViewport] = useState<MockupViewport>('desktop');
  const [presentMode, setPresentMode] = useState(false);
  const [rightSidebarPanel, setRightSidebarPanel] = useState<'versions' | 'layers' | null>(
    'versions'
  );
  const [selectedLayer, setSelectedLayer] = useState<MockupLayerTarget | null>(null);
  const [selectedExportSections, setSelectedExportSections] = useState<
    ExportableCanvasSectionKey[]
  >(['hero', 'services', 'projects', 'about', 'quote']);
  const [pngExportModalOpen, setPngExportModalOpen] = useState(false);
  const [isExportingPngs, setIsExportingPngs] = useState(false);
  const [exportingSingleKey, setExportingSingleKey] =
    useState<ExportableCanvasSectionKey | null>(null);
  const [pngExportNotice, setPngExportNotice] = useState<string | null>(null);
  const pngNoticeTimerRef = useRef<number | null>(null);
  const { user, getIdToken, signInWithGoogle } = useAuth();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brand');
  const [cloudMockups, setCloudMockups] = useState<DbSavedMockupSummary[]>([]);
  const [isLoadingCloudMockups, setIsLoadingCloudMockups] = useState(false);
  const [isSavingCloudMockup, setIsSavingCloudMockup] = useState(false);
  const [revertingVersionId, setRevertingVersionId] = useState<number | null>(null);
  const [cloudMockupError, setCloudMockupError] = useState<string | null>(null);
  const [preRevertProject, setPreRevertProject] = useState<SiteMockupProject | null>(null);
  const [revertFeedback, setRevertFeedback] = useState<{
    restoredLabel: string;
    canUndo: boolean;
  } | null>(null);
  const versionJsonCacheRef = useRef<Map<number, string>>(new Map());
  const [copiedJson, setCopiedJson] = useState(false);
  const [exportedHtml, setExportedHtml] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [pitchSheetOpen, setPitchSheetOpen] = useState(false);
  const [pitchPdfSaved, setPitchPdfSaved] = useState(false);
  const pitchPdfTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoOpenPitchSheet) {
      setPitchSheetOpen(true);
      onAutoOpenPitchSheetHandled?.();
    }
  }, [autoOpenPitchSheet, onAutoOpenPitchSheetHandled]);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const resetFeedbackTimerRef = useRef<number | null>(null);
  const [contrastFixedFeedback, setContrastFixedFeedback] = useState(false);
  const contrastFixedTimerRef = useRef<number | null>(null);

  // Drag-and-drop section reordering state
  const [draggedSectionKey, setDraggedSectionKey] = useState<MockupSectionKey | null>(null);
  const [dragOverSectionKey, setDragOverSectionKey] = useState<MockupSectionKey | null>(null);

  // Section AI Polish controls
  const [polishInstruction, setPolishInstruction] = useState('');
  const [isPolishingSection, setIsPolishingSection] = useState<string | null>(null);
  const [polishError, setPolishError] = useState<string | null>(null);

  const activeContentHash = useMemo(
    () => computeMockupContentHash(project),
    [project]
  );

  // Auto-save manual local snapshots for reliable on-site breaks
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SNAPSHOTS_KEY, JSON.stringify(snapshots));
    } catch {
      // Ignore quota errors
    }
  }, [snapshots]);

  const loadCloudVersions = useCallback(async () => {
    if (!user) {
      setCloudMockups([]);
      return;
    }
    setIsLoadingCloudMockups(true);
    setCloudMockupError(null);
    try {
      const token = await getIdToken();
      if (!token) {
        setCloudMockups([]);
        return;
      }
      const rows = await fetchDbMockups(token);
      setCloudMockups(rows);
    } catch (err) {
      setCloudMockupError(
        err instanceof Error ? err.message : 'Could not load saved versions.'
      );
    } finally {
      setIsLoadingCloudMockups(false);
    }
  }, [getIdToken, user]);

  // Load Cloud SQL saved mockup iterations when signed in or opening Version History
  useEffect(() => {
    if (!user) {
      setCloudMockups([]);
      versionJsonCacheRef.current.clear();
      return;
    }
    void loadCloudVersions();
  }, [user, loadCloudVersions]);

  useEffect(() => {
    return () => {
      if (swatchFeedbackTimerRef.current) window.clearTimeout(swatchFeedbackTimerRef.current);
      if (pairFeedbackTimerRef.current) window.clearTimeout(pairFeedbackTimerRef.current);
      if (slotFlashTimerRef.current) window.clearTimeout(slotFlashTimerRef.current);
      if (copiedHexTimerRef.current) window.clearTimeout(copiedHexTimerRef.current);
      if (resetFeedbackTimerRef.current) window.clearTimeout(resetFeedbackTimerRef.current);
      if (contrastFixedTimerRef.current) window.clearTimeout(contrastFixedTimerRef.current);
      if (zipFeedbackTimerRef.current) window.clearTimeout(zipFeedbackTimerRef.current);
      if (pngNoticeTimerRef.current) window.clearTimeout(pngNoticeTimerRef.current);
      if (pairingFeedbackTimerRef.current) window.clearTimeout(pairingFeedbackTimerRef.current);
    };
  }, []);

  const effectiveSuggestedPair = (() => {
    if (suggestedPair) return suggestedPair;
    const swatches = project.brandSwatches || [];
    if (swatches.length < 2) return null;
    const primarySwatch =
      swatches.find((s) => /primary|brand|dominant/i.test(s.role)) || swatches[0];
    const accentSwatch =
      swatches.find(
        (s) =>
          s.hex.toUpperCase() !== primarySwatch.hex.toUpperCase() &&
          /accent|cta|highlight|secondary/i.test(s.role)
      ) ||
      swatches.find((s) => s.hex.toUpperCase() !== primarySwatch.hex.toUpperCase()) ||
      swatches[1];
    return {
      primary: primarySwatch.hex.toUpperCase(),
      accent: accentSwatch.hex.toUpperCase(),
      canvasMode: project.brand.palette.canvasMode,
    };
  })();

  function triggerSlotFlash(slots: { primary?: boolean; accent?: boolean }) {
    if (slotFlashTimerRef.current) window.clearTimeout(slotFlashTimerRef.current);
    setFlashedSlots({
      primary: Boolean(slots.primary),
      accent: Boolean(slots.accent),
      seq: Date.now(),
    });
    slotFlashTimerRef.current = window.setTimeout(() => {
      setFlashedSlots(null);
    }, 950);
  }

  const contrastAudit = evaluateMockupContrast(
    project.brand.palette.primary,
    project.brand.palette.accent,
    project.brand.palette.canvasMode,
    project.brand.palette
  );

  async function handleAnalyzeSubmit(e?: FormEvent) {
    if (e) e.preventDefault();
    const cleanedUrl = urlInput.trim();
    const cleanedNotes = rawNotesInput.trim();
    if (!cleanedUrl && !cleanedNotes) {
      setAnalyzeError('Paste your mate’s website URL (or switch to Paste Notes) to generate a tailored mockup.');
      return;
    }

    setAnalyzeError(null);
    setColorExtractError(null);
    setImportNotice(null);
    setIsAnalyzing(true);
    try {
      const result = await analyzeWebsiteForMockup({
        url: cleanedUrl || undefined,
        rawNotes: cleanedNotes || undefined,
      });

      setUndoProject(project);
      const nextSwatches =
        result.brandSwatches && result.brandSwatches.length > 0
          ? result.brandSwatches
          : result.project.brandSwatches || [];

      setProject((prev) => ({
        ...result.project,
        id: prev.id,
        updatedAt: new Date().toISOString(),
        brand: {
          ...result.project.brand,
          logoDataUrl: prev.brand.logoDataUrl,
        },
        brandSwatches: nextSwatches,
        hero: {
          ...result.project.hero,
          photoDataUrl: prev.hero.photoDataUrl,
        },
        mediaCollection: prev.mediaCollection || [],
        siteNotes: prev.siteNotes,
      }));
      setSuggestedPair({
        primary: result.project.brand.palette.primary,
        accent: result.project.brand.palette.accent,
        canvasMode: result.project.brand.palette.canvasMode,
      });
      setPasteNotesOpen(false);
      setImportNotice(
        result.usedFallback
          ? `Mocked up ${result.project.brand.name} from web context — tweak any contact details or services on the left.`
          : `Imported ${result.project.brand.name} with ${nextSwatches.length} extracted brand swatches.`
      );
    } catch (err) {
      setAnalyzeError(
        err instanceof Error
          ? err.message
          : 'Could not reach that website. Click "Paste notes" to paste their About/Services text instead.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleExtractBrandColors() {
    const targetUrl = (urlInput.trim() || project.sourceUrl.trim());
    if (!targetUrl) {
      setColorExtractError(
        'Enter your mate’s website URL in the bar above first, then click Extract Colors.'
      );
      return;
    }

    setColorExtractError(null);
    setIsExtractingColors(true);
    try {
      const res = await extractWebsiteBrandColors(targetUrl);
      setUndoProject(project);
      updateProject((prev) => ({
        ...prev,
        sourceUrl: res.sourceUrl,
        brandSwatches: res.swatches,
      }));
      setSuggestedPair({
        primary: res.suggestedPrimary,
        accent: res.suggestedAccent,
        canvasMode: res.suggestedCanvasMode,
      });
      setImportNotice(
        `Extracted ${res.swatches.length} brand swatches from ${res.brandName || res.sourceUrl} without changing your copy.`
      );
    } catch (err) {
      setColorExtractError(
        err instanceof Error
          ? err.message
          : 'Could not extract brand colours from that URL right now.'
      );
    } finally {
      setIsExtractingColors(false);
    }
  }

  function triggerPairingAppliedFeedback(id: string, name: string) {
    if (pairingFeedbackTimerRef.current) {
      window.clearTimeout(pairingFeedbackTimerRef.current);
    }
    setAppliedPairingFeedback({ id, name, seq: Date.now() });
    pairingFeedbackTimerRef.current = window.setTimeout(() => {
      setAppliedPairingFeedback(null);
    }, 2200);
  }

  async function handleSuggestFontPairings(overrideUrl?: string) {
    const targetUrl = (overrideUrl ?? urlInput).trim() || project.sourceUrl.trim();
    if (!targetUrl) {
      setFontSuggestError(
        'Enter a website URL first so Gemini can inspect its fonts and suggest Google Font pairings.'
      );
      return;
    }

    setFontSuggestError(null);
    setIsSuggestingFonts(true);
    try {
      const res = await suggestWebsiteFontPairings({
        url: targetUrl,
        brandName: project.brand.name,
        industry: project.brand.industry,
      });

      const familiesToPreload: string[] = [];
      for (const pairing of res.pairings) {
        familiesToPreload.push(pairing.headingFont, pairing.bodyFont);
        if (pairing.monoFont) familiesToPreload.push(pairing.monoFont);
      }
      ensureGoogleFontsLoaded(familiesToPreload);

      setDetectedSiteFonts(res.detectedSiteFonts || []);
      updateProject((prev) => ({
        ...prev,
        sourceUrl: res.sourceUrl || prev.sourceUrl,
        suggestedFontPairings: res.pairings,
      }));
      if (!urlInput.trim() && res.sourceUrl) {
        setUrlInput(res.sourceUrl);
      }
      setImportNotice(
        `Suggested ${res.pairings.length} Google Font pairings for ${res.brandName || res.sourceUrl}.`
      );
    } catch (err) {
      setFontSuggestError(
        err instanceof Error
          ? err.message
          : 'Could not suggest Google Font pairings for that URL right now.'
      );
    } finally {
      setIsSuggestingFonts(false);
    }
  }

  function handleApplyFontPairing(pairing: MockupFontPairing) {
    setUndoProject(project);
    ensureGoogleFontsLoaded([
      pairing.headingFont,
      pairing.bodyFont,
      pairing.monoFont || 'IBM Plex Mono',
    ]);
    updateProject((prev) => ({
      ...prev,
      brand: {
        ...prev.brand,
        fontMood: pairing.mood,
        fontPairing: pairing,
      },
    }));
    triggerPairingAppliedFeedback(pairing.id, pairing.name);
  }

  function handleSelectCustomFont(
    slot: 'heading' | 'body',
    family: string,
    category: 'sans-serif' | 'serif' | 'display'
  ) {
    const current = resolveActiveFontPairing(
      project.brand.fontMood,
      project.brand.fontPairing
    );
    const nextPairing: MockupFontPairing = {
      ...current,
      id: `custom-${slot === 'heading' ? family : current.headingFont}-${slot === 'body' ? family : current.bodyFont}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
      name: 'Custom Pairing',
      headingFont: slot === 'heading' ? family : current.headingFont,
      headingCategory: slot === 'heading' ? category : current.headingCategory,
      bodyFont: slot === 'body' ? family : current.bodyFont,
      bodyCategory:
        slot === 'body'
          ? category === 'serif'
            ? 'serif'
            : 'sans-serif'
          : current.bodyCategory,
      rationale: `Custom pairing using ${slot === 'heading' ? family : current.headingFont} headings with ${slot === 'body' ? family : current.bodyFont} body copy.`,
      sourceNote: 'Custom override',
    };
    handleApplyFontPairing(nextPairing);
  }

  function handleSelectFontMood(mood: MockupFontMood) {
    const moodPairing = DEFAULT_PAIRING_BY_MOOD[mood];
    setUndoProject(project);
    ensureGoogleFontsLoaded([
      moodPairing.headingFont,
      moodPairing.bodyFont,
      moodPairing.monoFont || 'IBM Plex Mono',
    ]);
    updateProject((prev) => ({
      ...prev,
      brand: {
        ...prev.brand,
        fontMood: mood,
        fontPairing: moodPairing,
      },
    }));
    triggerPairingAppliedFeedback(moodPairing.id, moodPairing.name);
  }

  function handleResetTypography() {
    setUndoProject(project);
    const defaultPairing = DEFAULT_PAIRING_BY_MOOD.industrial;
    ensureGoogleFontsLoaded([
      defaultPairing.headingFont,
      defaultPairing.bodyFont,
      defaultPairing.monoFont || 'IBM Plex Mono',
    ]);
    updateProject((prev) => ({
      ...prev,
      brand: {
        ...prev.brand,
        fontMood: 'industrial',
        fontPairing: undefined,
      },
    }));
    triggerPairingAppliedFeedback(defaultPairing.id, defaultPairing.name);
  }

  async function handleCopyHex(hex: string) {
    const copied = await copyHexToClipboard(hex);
    if (!copied) return false;
    if (copiedHexTimerRef.current) window.clearTimeout(copiedHexTimerRef.current);
    setCopiedHex(copied);
    copiedHexTimerRef.current = window.setTimeout(() => {
      setCopiedHex((curr) => (curr === copied ? null : curr));
    }, 1800);
    return true;
  }

  async function handleApplySwatch(hex: string) {
    const normalized = hex.trim().toUpperCase().startsWith('#')
      ? hex.trim().toUpperCase()
      : `#${hex.trim().toUpperCase()}`;
    const targetSlot = swatchApplyTarget;

    if (targetSlot !== 'copy') {
      setUndoProject(project);
      updateProject((p) => ({
        ...p,
        brand: {
          ...p.brand,
          palette: {
            primary: p.brand.palette.primary,
            accent: p.brand.palette.accent,
            canvasMode: p.brand.palette.canvasMode,
            [targetSlot]: normalized,
          },
        },
      }));
      triggerSlotFlash({ [targetSlot]: true });
    }

    const copied = await handleCopyHex(normalized);
    if (swatchFeedbackTimerRef.current) window.clearTimeout(swatchFeedbackTimerRef.current);
    setAppliedSwatchFeedback({
      hex: normalized,
      slot: targetSlot,
      copied,
      seq: Date.now(),
    });
    swatchFeedbackTimerRef.current = window.setTimeout(() => {
      setAppliedSwatchFeedback(null);
    }, 1700);
  }

  function handleApplyColorPair(
    id: string,
    label: string,
    pair: { primary: string; accent: string; canvasMode: MockupCanvasMode }
  ) {
    setUndoProject(project);
    updateProject((p) => ({
      ...p,
      brand: {
        ...p.brand,
        palette: {
          primary: pair.primary.toUpperCase(),
          accent: pair.accent.toUpperCase(),
          canvasMode: pair.canvasMode,
        },
      },
    }));
    if (pairFeedbackTimerRef.current) window.clearTimeout(pairFeedbackTimerRef.current);
    setAppliedPairFeedback({ id, label, seq: Date.now() });
    pairFeedbackTimerRef.current = window.setTimeout(() => {
      setAppliedPairFeedback(null);
    }, 1600);
    triggerSlotFlash({ primary: true, accent: true });
  }

  function handleApplySuggestedPair() {
    if (!effectiveSuggestedPair) return;
    handleApplyColorPair('suggested', 'Brand Pair', effectiveSuggestedPair);
  }

  function handleAutoFixContrast() {
    const fixed = autoFixMockupPalette(
      project.brand.palette.primary,
      project.brand.palette.accent,
      project.brand.palette.canvasMode,
      project.brand.palette
    );
    if (!fixed.changed) return;
    setUndoProject(project);
    updateProject((p) => ({
      ...p,
      brand: {
        ...p.brand,
        palette: {
          ...p.brand.palette,
          primary: fixed.primary,
          accent: fixed.accent,
          onPrimary: fixed.onPrimary,
          onAccent: fixed.onAccent,
          heroKickerText: fixed.heroKickerText,
          accentText: fixed.accentText,
        },
      },
    }));
    if (contrastFixedTimerRef.current) window.clearTimeout(contrastFixedTimerRef.current);
    setContrastFixedFeedback(true);
    contrastFixedTimerRef.current = window.setTimeout(() => {
      setContrastFixedFeedback(false);
    }, 1800);
  }

  function handleResetTextColors() {
    setUndoProject(project);
    updateProject((p) => ({
      ...p,
      brand: {
        ...p.brand,
        palette: {
          primary: p.brand.palette.primary,
          accent: p.brand.palette.accent,
          canvasMode: p.brand.palette.canvasMode,
        },
      },
    }));
  }

  async function handleLogoFile(file: File) {
    setMediaError(null);
    setUploadingSlot('logo');
    try {
      const compressed = await compressImageFile(file, {
        maxWidth: 480,
        maxHeight: 200,
        preserveAlpha: true,
        quality: 0.88,
        maxSizeKb: 140,
        canvas: compressionCanvasRef.current,
      });
      updateProject((p) => ({
        ...p,
        brand: { ...p.brand, logoDataUrl: compressed.dataUrl },
      }));
      setCompressionMetaBySlot((prev) => ({
        ...prev,
        logo: {
          originalSizeKb: compressed.originalSizeKb,
          sizeKb: compressed.sizeKb,
          savedPercent: compressed.savedPercent,
          width: compressed.width,
          height: compressed.height,
        },
      }));
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not process logo image.');
    } finally {
      setUploadingSlot(null);
    }
  }

  async function handleHeroPhotoFile(file: File) {
    setMediaError(null);
    setUploadingSlot('hero');
    try {
      const compressed = await compressImageFile(file, {
        maxWidth: 1200,
        maxHeight: 900,
        preserveAlpha: false,
        quality: 0.82,
        maxSizeKb: 220,
        canvas: compressionCanvasRef.current,
      });
      updateProject((p) => ({
        ...p,
        hero: { ...p.hero, photoDataUrl: compressed.dataUrl },
      }));
      setCompressionMetaBySlot((prev) => ({
        ...prev,
        hero: {
          originalSizeKb: compressed.originalSizeKb,
          sizeKb: compressed.sizeKb,
          savedPercent: compressed.savedPercent,
          width: compressed.width,
          height: compressed.height,
        },
      }));
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not process hero photo.');
    } finally {
      setUploadingSlot(null);
    }
  }

  async function handleProjectPhotoFile(projectId: string, file: File) {
    setMediaError(null);
    setUploadingSlot(projectId);
    try {
      const compressed = await compressImageFile(file, {
        maxWidth: 1000,
        maxHeight: 750,
        preserveAlpha: false,
        quality: 0.8,
        maxSizeKb: 180,
        canvas: compressionCanvasRef.current,
      });
      updateProject((p) => ({
        ...p,
        projects: p.projects.map((item) =>
          item.id === projectId ? { ...item, photoDataUrl: compressed.dataUrl } : item
        ),
      }));
      setCompressionMetaBySlot((prev) => ({
        ...prev,
        [projectId]: {
          originalSizeKb: compressed.originalSizeKb,
          sizeKb: compressed.sizeKb,
          savedPercent: compressed.savedPercent,
          width: compressed.width,
          height: compressed.height,
        },
      }));
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not process project photo.');
    } finally {
      setUploadingSlot(null);
    }
  }

  async function handleUploadProjectPhoto(
    projectId: string,
    e: ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await handleProjectPhotoFile(projectId, file);
  }

  async function handleAddCollectionFiles(
    files: File[],
    category: MockupMediaCategory
  ) {
    if (files.length === 0) return;
    setMediaError(null);
    setZipError(null);
    const addedAssets: MockupMediaAsset[] = [];
    const errors: string[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      setCollectionUploadProgress({ current: idx + 1, total: files.length });
      try {
        const isLogo = category === 'logo';
        const compressed = await compressImageFile(file, {
          maxWidth: isLogo ? 480 : 1200,
          maxHeight: isLogo ? 200 : 900,
          preserveAlpha: isLogo,
          quality: isLogo ? 0.88 : 0.82,
          maxSizeKb: isLogo ? 140 : 210,
          canvas: compressionCanvasRef.current,
        });
        const cleanLabel =
          file.name
            .replace(/\.[^.]+$/, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 48) || `Site Asset ${idx + 1}`;
        addedAssets.push({
          id: `asset-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          label: cleanLabel,
          category,
          dataUrl: compressed.dataUrl,
          width: compressed.width,
          height: compressed.height,
          sizeKb: compressed.sizeKb,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        errors.push(
          `${file.name}: ${err instanceof Error ? err.message : 'could not compress image'}`
        );
      }
    }

    setCollectionUploadProgress(null);

    if (addedAssets.length > 0) {
      updateProject((p) => ({
        ...p,
        mediaCollection: [...addedAssets, ...(p.mediaCollection || [])],
      }));
    }

    if (errors.length > 0) {
      setMediaError(errors.slice(0, 2).join(' · '));
    }
  }

  function handleRenameCollectionAsset(assetId: string, label: string) {
    updateProject((p) => ({
      ...p,
      mediaCollection: (p.mediaCollection || []).map((item) =>
        item.id === assetId ? { ...item, label } : item
      ),
    }));
  }

  function handleChangeCollectionAssetCategory(
    assetId: string,
    category: MockupMediaCategory
  ) {
    updateProject((p) => ({
      ...p,
      mediaCollection: (p.mediaCollection || []).map((item) =>
        item.id === assetId ? { ...item, category } : item
      ),
    }));
  }

  function handleAssignCollectionAssetToSlot(
    asset: MockupMediaAsset,
    slot: 'logo' | 'hero' | { projectId: string }
  ) {
    setUndoProject(project);
    if (slot === 'logo') {
      updateProject((p) => ({
        ...p,
        brand: { ...p.brand, logoDataUrl: asset.dataUrl },
      }));
      return;
    }
    if (slot === 'hero') {
      updateProject((p) => ({
        ...p,
        hero: { ...p.hero, photoDataUrl: asset.dataUrl },
      }));
      return;
    }
    updateProject((p) => ({
      ...p,
      projects: p.projects.map((item) =>
        item.id === slot.projectId ? { ...item, photoDataUrl: asset.dataUrl } : item
      ),
    }));
  }

  function handleDeleteCollectionAsset(assetId: string) {
    setUndoProject(project);
    updateProject((p) => ({
      ...p,
      mediaCollection: (p.mediaCollection || []).filter((item) => item.id !== assetId),
    }));
  }

  function handleSyncActiveSlotsToCollection() {
    const existing = project.mediaCollection || [];
    const existingUrls = new Set(existing.map((item) => item.dataUrl));
    const additions: MockupMediaAsset[] = [];
    const now = new Date().toISOString();

    if (project.brand.logoDataUrl && !existingUrls.has(project.brand.logoDataUrl)) {
      existingUrls.add(project.brand.logoDataUrl);
      additions.push({
        id: `asset-logo-${Date.now()}`,
        label: `${project.brand.name || 'Company'} Logo`,
        category: 'logo',
        dataUrl: project.brand.logoDataUrl,
        sizeKb: estimateDataUrlKb(project.brand.logoDataUrl),
        addedAt: now,
      });
    }

    if (project.hero.photoDataUrl && !existingUrls.has(project.hero.photoDataUrl)) {
      existingUrls.add(project.hero.photoDataUrl);
      additions.push({
        id: `asset-hero-${Date.now() + 1}`,
        label: 'Hero Site Photo',
        category: 'hero',
        dataUrl: project.hero.photoDataUrl,
        sizeKb: estimateDataUrlKb(project.hero.photoDataUrl),
        addedAt: now,
      });
    }

    project.projects.forEach((prj, idx) => {
      if (!prj.photoDataUrl || existingUrls.has(prj.photoDataUrl)) return;
      existingUrls.add(prj.photoDataUrl);
      additions.push({
        id: `asset-prj-${Date.now()}-${idx}`,
        label: prj.title || `Project ${idx + 1} Photo`,
        category: 'project',
        dataUrl: prj.photoDataUrl,
        sizeKb: estimateDataUrlKb(prj.photoDataUrl),
        addedAt: now,
      });
    });

    if (additions.length === 0) return;
    updateProject((p) => ({
      ...p,
      mediaCollection: [...additions, ...(p.mediaCollection || [])],
    }));
  }

  async function handleExportAssetsZip() {
    if (handoverAssets.length === 0) {
      setInspectorTab('media');
      setPresentMode(false);
      setZipError('Upload a logo or site photos first to export a client handover ZIP.');
      return;
    }

    setZipError(null);
    setIsExportingZip(true);
    try {
      const result = await exportMockupAssetsZip(project);
      if (zipFeedbackTimerRef.current) window.clearTimeout(zipFeedbackTimerRef.current);
      setExportedZipInfo(result);
      zipFeedbackTimerRef.current = window.setTimeout(() => {
        setExportedZipInfo(null);
      }, 3200);
    } catch (err) {
      setZipError(
        err instanceof Error ? err.message : 'Could not package project assets into a ZIP.'
      );
    } finally {
      setIsExportingZip(false);
    }
  }

  async function handlePolishSection(
    section: 'hero' | 'services' | 'projects' | 'about',
    presetInstruction?: string
  ) {
    const instruction = (presetInstruction ?? polishInstruction).trim();
    if (!instruction) return;
    setPolishError(null);
    setIsPolishingSection(section);
    try {
      const res = await rewriteMockupSection({
        section,
        project,
        instruction,
      });
      setUndoProject(project);
      updateProject((prev) => ({
        ...prev,
        ...res.patch,
      }));
      if (!presetInstruction) setPolishInstruction('');
    } catch (err) {
      setPolishError(
        err instanceof Error ? err.message : 'Could not polish this section right now.'
      );
    } finally {
      setIsPolishingSection(null);
    }
  }

  async function handleSaveVersion(input: { label: string; changeNote: string }) {
    setCloudMockupError(null);
    const cloned = JSON.parse(JSON.stringify(project)) as SiteMockupProject;
    const nextCloudVer =
      cloudMockups.length > 0
        ? Math.max(...cloudMockups.map((v) => v.versionNumber || 1)) + 1
        : 1;
    const resolvedLabel =
      input.label.trim() ||
      `${(cloned.brand.name || 'Mockup').slice(0, 22)} · v${
        user ? nextCloudVer : snapshots.length + 1
      }`;

    const saveLocalFallbackSnapshot = () => {
      const snap: MockupSnapshot = {
        id: `snap-${Date.now()}`,
        label: resolvedLabel,
        savedAt: new Date().toISOString(),
        project: cloned,
      };
      setSnapshots((prev) => [snap, ...prev].slice(0, 15));
    };

    if (user) {
      setIsSavingCloudMockup(true);
      try {
        const token = await getIdToken();
        if (!token) {
          throw new Error('Authentication session expired. Please sign in again.');
        }
        const serialized = JSON.stringify(cloned);
        const saved = await saveDbMockup(token, {
          label: resolvedLabel,
          changeNote: input.changeNote.trim(),
          brandName: cloned.brand.name || '',
          headlinePreview: cloned.hero.headline || '',
          primaryColor: cloned.brand.palette.primary,
          accentColor: cloned.brand.palette.accent,
          canvasMode: cloned.brand.palette.canvasMode,
          assetCount: countMockupUniqueAssets(cloned),
          contentHash: activeContentHash,
          sourceUrl: cloned.sourceUrl || '',
          projectJson: serialized,
        });
        versionJsonCacheRef.current.set(saved.id, saved.projectJson || serialized);
        const { projectJson: _omitted, ...summary } = saved;
        setCloudMockups((prev) => [summary, ...prev]);
      } catch (err) {
        saveLocalFallbackSnapshot();
        setCloudMockupError(
          `${
            err instanceof Error ? err.message : 'Cloud database unavailable.'
          } Saved "${resolvedLabel}" to Session Drafts so nothing is lost.`
        );
      } finally {
        setIsSavingCloudMockup(false);
      }
      return;
    }

    saveLocalFallbackSnapshot();
  }

  async function handleRevertCloudVersion(row: DbSavedMockupSummary) {
    if (!user) return;
    setCloudMockupError(null);
    setRevertingVersionId(row.id);
    try {
      let rawJson = versionJsonCacheRef.current.get(row.id);
      if (!rawJson) {
        const token = await getIdToken();
        if (!token) {
          throw new Error('Authentication session expired. Please sign in again.');
        }
        const fullRow = await fetchDbMockupById(token, row.id);
        rawJson = fullRow.projectJson;
        versionJsonCacheRef.current.set(row.id, rawJson);
      }

      const parsed = JSON.parse(rawJson) as Partial<SiteMockupProject>;
      if (!parsed || typeof parsed !== 'object' || !parsed.brand) {
        setCloudMockupError('This saved iteration is incomplete and cannot be restored.');
        return;
      }

      const restored = normalizeRestoredMockupProject(parsed, project.id);
      if (restored.brand.fontPairing) {
        ensureGoogleFontsLoaded([
          restored.brand.fontPairing.headingFont,
          restored.brand.fontPairing.bodyFont,
          restored.brand.fontPairing.monoFont || 'IBM Plex Mono',
        ]);
      }

      setPreRevertProject(project);
      setUndoProject(project);
      setProject(restored);
      setUrlInput(restored.sourceUrl || row.sourceUrl || '');
      setRevertFeedback({
        restoredLabel: `v${row.versionNumber || 1} · ${row.label}`,
        canUndo: true,
      });
    } catch (err) {
      setCloudMockupError(
        err instanceof Error ? err.message : 'Could not restore that mockup iteration.'
      );
    } finally {
      setRevertingVersionId(null);
    }
  }

  async function handleUpdateCloudVersionMeta(
    id: number,
    input: { label: string; changeNote: string }
  ) {
    if (!user) return;
    setCloudMockupError(null);
    try {
      const token = await getIdToken();
      if (!token) return;
      const updated = await updateDbMockupMeta(token, id, input);
      setCloudMockups((prev) =>
        prev.map((item) => (item.id === id ? updated : item))
      );
    } catch (err) {
      setCloudMockupError(
        err instanceof Error ? err.message : 'Could not update version details.'
      );
    }
  }

  async function handleDeleteCloudMockup(id: number) {
    if (!user) return;
    setCloudMockupError(null);
    try {
      const token = await getIdToken();
      if (!token) return;
      await deleteDbMockup(token, id);
      versionJsonCacheRef.current.delete(id);
      setCloudMockups((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setCloudMockupError(
        err instanceof Error ? err.message : 'Could not delete mockup iteration.'
      );
    }
  }

  function handleRevertLocalSnapshot(snap: MockupSnapshot) {
    const restored = normalizeRestoredMockupProject(snap.project, project.id);
    if (restored.brand.fontPairing) {
      ensureGoogleFontsLoaded([
        restored.brand.fontPairing.headingFont,
        restored.brand.fontPairing.bodyFont,
        restored.brand.fontPairing.monoFont || 'IBM Plex Mono',
      ]);
    }
    setPreRevertProject(project);
    setUndoProject(project);
    setProject(restored);
    setUrlInput(restored.sourceUrl || '');
    setRevertFeedback({
      restoredLabel: snap.label,
      canUndo: true,
    });
  }

  function handleUndoRevert() {
    if (!preRevertProject) return;
    setProject(preRevertProject);
    setUrlInput(preRevertProject.sourceUrl || '');
    setPreRevertProject(null);
    setRevertFeedback(null);
  }

  const orderedSections = normalizeSectionOrder(project.sectionOrder);
  const lockedSections = project.lockedSections || {};
  const lockedSectionCount = orderedSections.filter((k) => Boolean(lockedSections[k])).length;
  const isCustomSectionOrder = orderedSections.some(
    (key, idx) => key !== DEFAULT_SECTION_ORDER[idx]
  );

  function handleReorderSections(nextOrder: MockupSectionKey[]) {
    const normalized = normalizeSectionOrder(nextOrder);
    updateProject((p) => ({
      ...p,
      sectionOrder: normalized,
    }));
  }

  function handleMoveSectionWithLocks(
    sourceKey: MockupSectionKey,
    targetKey: MockupSectionKey
  ) {
    if (
      sourceKey === targetKey ||
      lockedSections[sourceKey] ||
      lockedSections[targetKey]
    ) {
      return;
    }
    const unlockedIndices: number[] = [];
    const unlockedKeys: MockupSectionKey[] = [];
    orderedSections.forEach((key, idx) => {
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

    const next = [...orderedSections];
    unlockedIndices.forEach((slotIdx, i) => {
      next[slotIdx] = unlockedKeys[i];
    });
    handleReorderSections(next);
  }

  function handleNudgeLayerKey(key: MockupSectionKey, direction: -1 | 1) {
    if (lockedSections[key]) return;
    const unlockedKeys = orderedSections.filter((k) => !lockedSections[k]);
    const pos = unlockedKeys.indexOf(key);
    const neighborKey = unlockedKeys[pos + direction];
    if (!neighborKey) return;
    handleMoveSectionWithLocks(key, neighborKey);
  }

  function handleToggleSectionVisibility(key: MockupSectionKey) {
    if (lockedSections[key]) return;
    updateProject((p) => ({
      ...p,
      sectionVisibility: {
        ...p.sectionVisibility,
        [key]: !p.sectionVisibility[key],
      },
    }));
  }

  function handleToggleSectionLock(key: MockupSectionKey) {
    updateProject((p) => ({
      ...p,
      lockedSections: {
        ...(p.lockedSections || {}),
        [key]: !p.lockedSections?.[key],
      },
    }));
  }

  function handleShowAllSections() {
    updateProject((p) => {
      const nextVis = { ...p.sectionVisibility };
      orderedSections.forEach((key) => {
        if (!p.lockedSections?.[key]) {
          nextVis[key] = true;
        }
      });
      return {
        ...p,
        sectionVisibility: nextVis,
      };
    });
  }

  function handleUnlockAllSections() {
    updateProject((p) => ({
      ...p,
      lockedSections: {},
    }));
  }

  function handleResetSectionOrder() {
    const unlockedIndices: number[] = [];
    const unlockedKeys: MockupSectionKey[] = [];
    orderedSections.forEach((key, idx) => {
      if (!lockedSections[key]) {
        unlockedIndices.push(idx);
        unlockedKeys.push(key);
      }
    });
    const sortedUnlocked = [...unlockedKeys].sort(
      (a, b) => DEFAULT_SECTION_ORDER.indexOf(a) - DEFAULT_SECTION_ORDER.indexOf(b)
    );
    const next = [...orderedSections];
    unlockedIndices.forEach((slotIdx, i) => {
      next[slotIdx] = sortedUnlocked[i];
    });
    handleReorderSections(next);
  }

  function handleSelectLayer(target: MockupLayerTarget) {
    setSelectedLayer(target);
    const tabMap: Record<MockupLayerTarget, InspectorTab> = {
      hero: 'hero',
      services: 'services',
      projects: 'proof',
      about: 'proof',
      quote: 'contact',
      footer: 'contact',
    };
    setInspectorTab(tabMap[target]);
    const anchorMap: Record<MockupLayerTarget, string> = {
      hero: 'mockup-top',
      services: 'mockup-services',
      projects: 'mockup-projects',
      about: 'mockup-about',
      quote: 'mockup-quote',
      footer: 'mockup-footer',
    };
    const el = document.getElementById(anchorMap[target]);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function showPngExportNotice(message: string) {
    if (pngNoticeTimerRef.current) window.clearTimeout(pngNoticeTimerRef.current);
    setPngExportNotice(message);
    pngNoticeTimerRef.current = window.setTimeout(() => {
      setPngExportNotice(null);
    }, 3000);
  }

  function handleToggleExportSection(key: ExportableCanvasSectionKey) {
    setSelectedExportSections((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  }

  function handleSelectAllVisibleExportSections() {
    const visibleKeys: ExportableCanvasSectionKey[] = [
      'hero',
      ...orderedSections.filter((k) => project.sectionVisibility[k]),
      'footer',
    ];
    setSelectedExportSections(visibleKeys);
  }

  function handleClearExportSections() {
    setSelectedExportSections([]);
  }

  async function handleQuickExportSinglePng(key: ExportableCanvasSectionKey) {
    setIsExportingPngs(true);
    setExportingSingleKey(key);
    try {
      const captured = await captureSectionAsTransparentPng(key, {
        brandName: project.brand.name,
        pixelRatio: 2,
        transparentBackdrop: true,
      });
      triggerPngBlobDownload(captured.blob, captured.filename);
      URL.revokeObjectURL(captured.previewUrl);
      showPngExportNotice(`Saved ${captured.label} PNG`);
    } catch (err) {
      showPngExportNotice(
        err instanceof Error ? err.message : 'Could not export PNG.'
      );
    } finally {
      setIsExportingPngs(false);
      setExportingSingleKey(null);
    }
  }

  async function handleQuickExportSelectedPngs() {
    const orderedCanvasKeys: ExportableCanvasSectionKey[] = [
      'hero',
      ...orderedSections,
      'footer',
    ];
    const targetKeys = orderedCanvasKeys.filter((k) => {
      const visible = k === 'hero' || k === 'footer' ? true : Boolean(project.sectionVisibility[k]);
      return visible && selectedExportSections.includes(k);
    });

    if (targetKeys.length === 0) return;

    setIsExportingPngs(true);
    setExportingSingleKey(null);
    try {
      const captured = [];
      for (const key of targetKeys) {
        const asset = await captureSectionAsTransparentPng(key, {
          brandName: project.brand.name,
          pixelRatio: 2,
          transparentBackdrop: true,
        });
        captured.push(asset);
      }
      await downloadCapturedSectionPngsIndividually(captured);
      captured.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      showPngExportNotice(
        `Exported ${captured.length} transparent PNG${captured.length === 1 ? '' : 's'}`
      );
    } catch (err) {
      showPngExportNotice(
        err instanceof Error ? err.message : 'Could not export selected PNGs.'
      );
    } finally {
      setIsExportingPngs(false);
    }
  }

  function handleInspectorDragStart(
    e: DragEvent<HTMLDivElement>,
    key: MockupSectionKey
  ) {
    if (lockedSections[key]) {
      e.preventDefault();
      return;
    }
    setDraggedSectionKey(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  }

  function handleInspectorDragOver(
    e: DragEvent<HTMLDivElement>,
    key: MockupSectionKey
  ) {
    if (!draggedSectionKey || draggedSectionKey === key || lockedSections[key]) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverSectionKey !== key) {
      setDragOverSectionKey(key);
    }
  }

  function handleInspectorDrop(
    e: DragEvent<HTMLDivElement>,
    targetKey: MockupSectionKey
  ) {
    e.preventDefault();
    const sourceKey = (draggedSectionKey ||
      (e.dataTransfer.getData('text/plain') as MockupSectionKey)) as MockupSectionKey;
    if (
      sourceKey &&
      sourceKey !== targetKey &&
      !lockedSections[sourceKey] &&
      !lockedSections[targetKey]
    ) {
      handleMoveSectionWithLocks(sourceKey, targetKey);
    }
    setDraggedSectionKey(null);
    setDragOverSectionKey(null);
  }

  function handleInspectorDragEnd() {
    setDraggedSectionKey(null);
    setDragOverSectionKey(null);
  }

  function handleNudgeSection(index: number, delta: -1 | 1) {
    const key = orderedSections[index];
    if (!key) return;
    handleNudgeLayerKey(key, delta);
  }

  function handleResetMockup() {
    setUndoProject(project);
    const fresh = createStarterMockup();

    // Preserve all uploaded assets (company logo, hero photo, and uploaded project photos)
    const preservedLogo = project.brand.logoDataUrl;
    const preservedHeroPhoto = project.hero.photoDataUrl;

    const assignedPhotos = new Map<number, string>();
    const overflowPhotos: Array<{ title: string; photoDataUrl: string }> = [];

    project.projects.forEach((item, idx) => {
      if (!item.photoDataUrl) return;
      if (idx < fresh.projects.length) {
        assignedPhotos.set(idx, item.photoDataUrl);
      } else {
        overflowPhotos.push({ title: item.title, photoDataUrl: item.photoDataUrl });
      }
    });

    // Place any overflow uploaded photos into open starter slots first
    for (let idx = 0; idx < fresh.projects.length && overflowPhotos.length > 0; idx++) {
      if (!assignedPhotos.has(idx)) {
        const nextPhoto = overflowPhotos.shift();
        if (nextPhoto) assignedPhotos.set(idx, nextPhoto.photoDataUrl);
      }
    }

    const mergedProjects = fresh.projects.map((item, idx) => ({
      ...item,
      photoDataUrl: assignedPhotos.get(idx),
    }));

    // If the user uploaded more project photos than default starter cards, keep them all
    overflowPhotos.forEach((extra, extraIdx) => {
      mergedProjects.push({
        id: `prj-kept-${extraIdx + 1}`,
        title: extra.title || `Uploaded Site Photo ${extraIdx + 1}`,
        location: fresh.brand.serviceArea,
        metric: 'Uploaded asset preserved',
        summary: 'Preserved uploaded site photo after canvas reset.',
        photoDataUrl: extra.photoDataUrl,
      });
    });

    const preservedCollection = project.mediaCollection || [];
    const nextProject: SiteMockupProject = {
      ...fresh,
      id: project.id,
      brand: {
        ...fresh.brand,
        logoDataUrl: preservedLogo,
      },
      hero: {
        ...fresh.hero,
        photoDataUrl: preservedHeroPhoto,
      },
      projects: mergedProjects,
      mediaCollection: preservedCollection,
    };

    const preservedAssetCount = collectProjectAssets(nextProject).length;

    setProject(nextProject);
    setUrlInput('');
    setSuggestedPair(null);
    setDetectedSiteFonts([]);
    setFontSuggestError(null);
    setAppliedPairingFeedback(null);
    setAnalyzeError(null);
    setColorExtractError(null);
    setPolishError(null);
    setImportNotice(
      preservedAssetCount > 0
        ? `Mockup canvas reset to defaults — ${preservedAssetCount} uploaded asset${
            preservedAssetCount === 1 ? '' : 's'
          } preserved.`
        : 'Mockup canvas reset to the default starter layout.'
    );
    if (resetFeedbackTimerRef.current) window.clearTimeout(resetFeedbackTimerRef.current);
    setResetConfirmed(true);
    resetFeedbackTimerRef.current = window.setTimeout(() => {
      setResetConfirmed(false);
    }, 1800);
  }

  function handleExportHtml() {
    const html = buildStandaloneMockupHtml(project);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = project.brand.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slug || 'site'}-mockup.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setExportedHtml(true);
    setTimeout(() => setExportedHtml(false), 2000);
  }

  async function handleCopyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(project, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      // Clipboard blocked
    }
  }

  function moveItem<T>(arr: T[], from: number, to: number): T[] {
    if (to < 0 || to >= arr.length) return arr;
    const copy = [...arr];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  }

  const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
    { id: 'brand', label: 'Brand' },
    { id: 'typography', label: 'Typography' },
    { id: 'media', label: 'Photos' },
    { id: 'hero', label: 'Hero' },
    { id: 'services', label: 'Services' },
    { id: 'proof', label: 'Proof' },
    { id: 'contact', label: 'Contact' },
    { id: 'notes', label: 'Notes' },
  ];

  const handoverAssets = collectProjectAssets(project);
  const totalMediaKb = handoverAssets.reduce((acc, item) => acc + item.sizeKb, 0);

  const savedTimeLabel = (() => {
    const d = new Date(project.updatedAt);
    if (Number.isNaN(d.getTime())) return 'Saved locally';
    return `Saved ${new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)}`;
  })();

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] flex flex-col bg-[#0B0D10]">
      {/* Hidden canvas used for deterministic client-side image downscaling & compression */}
      <canvas ref={compressionCanvasRef} className="hidden" aria-hidden="true" />
      {/* Full-Width Studio Toolbar */}
      <div className="border-b border-[#22D3EE]/25 bg-[#0E1116] px-4 sm:px-6 py-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Website URL Importer */}
          <form
            onSubmit={handleAnalyzeSubmit}
            className="flex flex-1 min-w-[280px] max-w-2xl items-center gap-2"
          >
            <div className="relative flex-1 min-w-0">
              <Globe
                className="w-4 h-4 text-[#22D3EE] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <label htmlFor="mockup-url-input" className="sr-only">
                Website URL to analyze and mock up
              </label>
              <input
                id="mockup-url-input"
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Paste your mate's website URL (e.g. hiscompany.co.uk)"
                disabled={isAnalyzing}
                className="w-full h-9 pl-9 pr-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md placeholder:text-[#6E788A]"
              />
            </div>

            <button
              type="submit"
              disabled={isAnalyzing}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Analyze &amp; Mock Up
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setPasteNotesOpen((v) => !v)}
              aria-expanded={pasteNotesOpen}
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                pasteNotesOpen
                  ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]/55'
                  : 'bg-[#13161C] text-[#A0AABB] border-[#2A3342] hover:text-[#F5F7FA]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" aria-hidden="true" />
              Paste Notes
            </button>
          </form>

          {/* Right: Viewport, Edit/Present, Versions, Export */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Viewport Switcher */}
            <div
              role="group"
              aria-label="Preview viewport size"
              className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#222833] rounded-md"
            >
              {(
                [
                  { id: 'desktop', icon: Monitor, label: 'Desktop preview' },
                  { id: 'tablet', icon: Tablet, label: 'Tablet preview' },
                  { id: 'mobile', icon: Smartphone, label: 'Mobile preview' },
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
                    className={`w-8 h-8 inline-flex items-center justify-center rounded transition-colors cursor-pointer ${
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

            {/* Layer Manager Sidebar Toggle */}
            {!presentMode && (
              <button
                type="button"
                onClick={() =>
                  setRightSidebarPanel((curr) => (curr === 'layers' ? null : 'layers'))
                }
                aria-pressed={rightSidebarPanel === 'layers'}
                title={
                  rightSidebarPanel === 'layers'
                    ? 'Hide layer manager sidebar'
                    : 'Show layer manager sidebar'
                }
                className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  rightSidebarPanel === 'layers'
                    ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]/55'
                    : 'bg-[#13161C] text-[#A0AABB] border-[#2A3342] hover:text-[#F5F7FA]'
                }`}
              >
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                Layers
                {lockedSectionCount > 0 && (
                  <Lock className="w-3 h-3 text-[#F59E0B]" aria-hidden="true" />
                )}
              </button>
            )}

            {/* Version History Sidebar Toggle */}
            <button
              type="button"
              onClick={() =>
                setRightSidebarPanel((curr) => (curr === 'versions' ? null : 'versions'))
              }
              aria-pressed={rightSidebarPanel === 'versions'}
              title={
                rightSidebarPanel === 'versions'
                  ? 'Hide version history sidebar'
                  : 'Open version history sidebar'
              }
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                rightSidebarPanel === 'versions'
                  ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]/55'
                  : 'bg-[#13161C] text-[#A0AABB] border-[#2A3342] hover:text-[#F5F7FA]'
              }`}
            >
              <History className="w-3.5 h-3.5" aria-hidden="true" />
              Version History
              {(user ? cloudMockups.length + snapshots.length : snapshots.length) > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
                  ({user ? cloudMockups.length + snapshots.length : snapshots.length})
                </span>
              )}
            </button>

            {/* Edit vs Present Toggle */}
            <button
              type="button"
              onClick={() => setPresentMode((v) => !v)}
              aria-pressed={presentMode}
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                presentMode
                  ? 'bg-[#22D3EE] text-[#071318] border-[#22D3EE] font-semibold'
                  : 'bg-[#13161C] text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/55'
              }`}
            >
              {presentMode ? (
                <>
                  <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
                  Back to Editor
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Full Preview
                </>
              )}
            </button>

            {/* Firestore Live Sync Action */}
            {user ? (
              <button
                type="button"
                onClick={() => void forceSyncNow()}
                disabled={syncStatus === 'syncing' || syncStatus === 'connecting'}
                title={
                  syncError
                    ? `${syncError} Click to retry Firestore sync.`
                    : 'Sync branding & media across sessions in Firestore'
                }
                className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  syncStatus === 'error'
                    ? 'bg-red-950/50 text-red-200 border-red-400/45 hover:bg-red-950/75'
                    : syncStatus === 'synced'
                      ? 'bg-[#13161C] text-[#67E8F9] border-[#22D3EE]/35 hover:border-[#22D3EE]/60'
                      : 'bg-[#13161C] text-[#A0AABB] border-[#2A3342] hover:text-[#F5F7FA]'
                }`}
              >
                {syncStatus === 'syncing' || syncStatus === 'connecting' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" aria-hidden="true" />
                ) : syncStatus === 'error' ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-300" aria-hidden="true" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                )}
                {syncStatus === 'syncing'
                  ? 'Syncing...'
                  : syncStatus === 'connecting'
                    ? 'Connecting...'
                    : syncStatus === 'error'
                      ? 'Retry Sync'
                      : 'Synced'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                title="Sign in with Google to sync branding & media across sessions"
                className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border bg-[#13161C] text-[#A0AABB] border-[#2A3342] hover:text-[#67E8F9] hover:border-[#22D3EE]/45 whitespace-nowrap cursor-pointer"
              >
                <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                Sync Cloud
              </button>
            )}

            {/* Reset Mockup (Preserves Uploaded Assets) */}
            <button
              type="button"
              onClick={handleResetMockup}
              title="Revert canvas copy, colours, and section order to defaults while keeping uploaded logos and photos"
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                resetConfirmed
                  ? 'bg-[#132422] text-[#34D399] border-[#34D399]/60'
                  : 'bg-[#13161C] text-[#A0AABB] hover:text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/50'
              }`}
            >
              {resetConfirmed ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34D399]" aria-hidden="true" />
                  Canvas Reset
                </>
              ) : (
                <>
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Reset Mockup
                </>
              )}
            </button>

            {/* One-Click 3D Laptop + Phone Device Showcase */}
            {onPreviewIn3DDevices && (
              <button
                type="button"
                onClick={() => onPreviewIn3DDevices(project)}
                title="Project live desktop and mobile website mockups onto the interactive 3D Laptop & Phone Showcase rig"
                className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#13161C] border border-[#22D3EE]/50 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                3D Device Preview
              </button>
            )}

            {/* Shareable Client Preview Link */}
            <button
              type="button"
              onClick={() => setShareModalOpen(true)}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Share Mockup
            </button>

            {/* Single-Page Client Pitch Summary — Print to PDF */}
            <button
              type="button"
              onClick={() => setPitchSheetOpen(true)}
              title="Open single-page client pitch summary to Print to PDF (branding colors, typography, service area, and project metrics)"
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                pitchPdfSaved
                  ? 'bg-[#132422] text-[#34D399] border-[#34D399]/60'
                  : 'bg-[#13161C] text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/60'
              }`}
            >
              {pitchPdfSaved ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34D399]" aria-hidden="true" />
                  PDF Saved
                </>
              ) : (
                <>
                  <Printer className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Print to PDF
                </>
              )}
            </button>

            {/* Export Selected Sections as Transparent PNGs */}
            <button
              type="button"
              onClick={() => setPngExportModalOpen(true)}
              title="Select specific canvas sections and export them as individual transparent PNG assets"
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <ImageDown className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Section PNGs
            </button>

            {/* Export Client Handover Assets ZIP */}
            <button
              type="button"
              disabled={isExportingZip}
              onClick={handleExportAssetsZip}
              title={
                handoverAssets.length > 0
                  ? `Export ${handoverAssets.length} uploaded asset${
                      handoverAssets.length === 1 ? '' : 's'
                    } as a single client handover ZIP`
                  : 'Open Photos tab to upload logos or site photos for ZIP export'
              }
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                exportedZipInfo
                  ? 'bg-[#132422] text-[#34D399] border-[#34D399]/60'
                  : handoverAssets.length > 0
                    ? 'bg-[#13161C] text-[#F5F7FA] border-[#22D3EE]/50 hover:border-[#22D3EE]'
                    : 'bg-[#13161C] text-[#A0AABB] hover:text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/50'
              }`}
            >
              {isExportingZip ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" aria-hidden="true" />
                  Zipping...
                </>
              ) : exportedZipInfo ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34D399]" aria-hidden="true" />
                  ZIP Saved
                </>
              ) : (
                <>
                  <Archive className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Assets ZIP
                  {handoverAssets.length > 0 && (
                    <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
                      ({handoverAssets.length})
                    </span>
                  )}
                </>
              )}
            </button>

            {/* Export HTML */}
            <button
              type="button"
              onClick={handleExportHtml}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/50 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              {exportedHtml ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34D399]" aria-hidden="true" />
                  Exported
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  HTML
                </>
              )}
            </button>
          </div>
        </div>

        {/* Optional Paste Notes / Raw Copy Drawer */}
        {pasteNotesOpen && (
          <div className="pt-2 border-t border-[#1F2532] flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-end">
            <div className="flex-1">
              <label
                htmlFor="mockup-raw-notes"
                className="block text-xs font-medium text-[#A0AABB] mb-1"
              >
                Paste existing site copy, Facebook About info, or rough notes about your mate&apos;s business
              </label>
              <textarea
                id="mockup-raw-notes"
                rows={3}
                value={rawNotesInput}
                onChange={(e) => setRawNotesInput(e.target.value)}
                placeholder="e.g., Dave's Concrete & Groundworks, based in Coventry, 15 years experience, footings, driveways, drainage, phone 07700..."
                className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md leading-relaxed"
              />
            </div>
            <button
              type="button"
              disabled={isAnalyzing || (!rawNotesInput.trim() && !urlInput.trim())}
              onClick={() => handleAnalyzeSubmit()}
              className="h-9 px-4 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isAnalyzing ? 'Building...' : 'Build from Notes'}
            </button>
          </div>
        )}

        {/* Inline Feedback Bar */}
        {(analyzeError || importNotice || undoProject) && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              {analyzeError && (
                <p role="alert" className="text-[#FCA5A5]">
                  {analyzeError}
                </p>
              )}
              {!analyzeError && importNotice && (
                <p className="text-[#67E8F9]">{importNotice}</p>
              )}
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px] text-[#6E788A] shrink-0">
              {undoProject && (
                <button
                  type="button"
                  onClick={() => {
                    setProject(undoProject);
                    setUrlInput(undoProject.sourceUrl || '');
                    setUndoProject(null);
                  }}
                  className="inline-flex items-center gap-1 text-[#67E8F9] hover:underline cursor-pointer"
                >
                  <Undo2 className="w-3 h-3" />
                  Undo last change
                </button>
              )}
              <span>{savedTimeLabel}</span>
            </div>
          </div>
        )}
      </div>

      {/* Main Split Workspace (Inspector + Live Full-Width Preview Canvas) */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left Collapsible Editor Inspector */}
        {!presentMode && (
          <aside
            aria-label="Mockup editor controls"
            className="w-full lg:w-[360px] xl:w-[390px] shrink-0 bg-[#101319] border-b lg:border-b-0 lg:border-r border-[#222833] flex flex-col"
          >
            {/* Inspector Tab Strip */}
            <div className="px-3 pt-3 pb-2 border-b border-[#1F2532] flex items-center gap-1 overflow-x-auto">
              {INSPECTOR_TABS.map((tab) => {
                const active = inspectorTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setInspectorTab(tab.id);
                      setPolishError(null);
                    }}
                    className={`h-8 px-2.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    {tab.label}
                    {tab.id === 'media' && handoverAssets.length > 0 && (
                      <span className="ml-1 font-mono text-[10px] tabular-nums opacity-80">
                        ({handoverAssets.length})
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Inspector Content Body */}
            <div className="p-4 sm:p-5 space-y-5 overflow-y-auto lg:max-h-[calc(100vh-11rem)]">
              {/* BRAND & THEME TAB */}
              {inspectorTab === 'brand' && (
                <>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                        Business Name
                      </label>
                      <input
                        type="text"
                        value={project.brand.name}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            brand: { ...p.brand, name: e.target.value },
                          }))
                        }
                        className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                        Industry / Trade
                      </label>
                      <input
                        type="text"
                        value={project.brand.industry}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            brand: { ...p.brand, industry: e.target.value },
                          }))
                        }
                        className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                    </div>
                      <div>
                      <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                        Service Area
                      </label>
                      <input
                        type="text"
                        value={project.brand.serviceArea}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            brand: { ...p.brand, serviceArea: e.target.value },
                          }))
                        }
                        className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                    </div>

                    {/* Company Logo Dropzone (Hidden Canvas Compression) */}
                    <MockupImageDropzone
                      label="Company Logo"
                      helperText="Header wordmark"
                      variant="logo"
                      dataUrl={project.brand.logoDataUrl}
                      isCompressing={uploadingSlot === 'logo'}
                      compressionMeta={compressionMetaBySlot.logo}
                      onSelectFile={handleLogoFile}
                      onRemove={() =>
                        updateProject((p) => ({
                          ...p,
                          brand: { ...p.brand, logoDataUrl: undefined },
                        }))
                      }
                    />
                    {mediaError && inspectorTab === 'brand' && (
                      <p role="alert" className="text-[11px] text-[#FCA5A5]">
                        {mediaError}
                      </p>
                    )}
                  </div>

                  {/* Brand Palette Controls */}
                  <div className="pt-4 border-t border-[#1F2532] space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F5F7FA]">
                        <Palette className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                        Brand Colours
                      </span>
                      <div className="inline-flex p-0.5 bg-[#0B0D10] border border-[#222833] rounded">
                        {(['light', 'dark'] as MockupCanvasMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() =>
                              updateProject((p) => ({
                                ...p,
                                brand: {
                                  ...p.brand,
                                  palette: {
                                    primary: p.brand.palette.primary,
                                    accent: p.brand.palette.accent,
                                    canvasMode: mode,
                                  },
                                },
                              }))
                            }
                            className={`px-2 py-0.5 text-[11px] font-medium rounded capitalize cursor-pointer ${
                              project.brand.palette.canvasMode === mode
                                ? 'bg-[#18212E] text-[#67E8F9]'
                                : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div
                        className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-md transition-[border-color,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                          flashedSlots?.primary
                            ? 'bg-[#131D29] border border-[#22D3EE] swatch-apply-pulse'
                            : 'bg-[#0B0D10] border border-[#2A3342] hover:border-[#22D3EE]/55'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1 text-xs text-[#D5DCE6] whitespace-nowrap">
                          Primary
                          {flashedSlots?.primary && (
                            <Check className="w-3 h-3 text-[#34D399]" aria-hidden="true" />
                          )}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCopyHex(project.brand.palette.primary)}
                            title={`Copy ${project.brand.palette.primary.toUpperCase()}`}
                            className="font-mono text-[11px] text-[#8C96A8] hover:text-[#67E8F9] tabular-nums transition-colors cursor-pointer"
                          >
                            {copiedHex === project.brand.palette.primary.toUpperCase()
                              ? 'Copied'
                              : project.brand.palette.primary.toUpperCase()}
                          </button>
                          <input
                            type="color"
                            aria-label="Pick primary brand color"
                            value={project.brand.palette.primary}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                brand: {
                                  ...p.brand,
                                  palette: {
                                    primary: e.target.value.toUpperCase(),
                                    accent: p.brand.palette.accent,
                                    canvasMode: p.brand.palette.canvasMode,
                                  },
                                },
                              }))
                            }
                            className="w-6 h-6 bg-transparent border-0 cursor-pointer"
                          />
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-md transition-[border-color,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                          flashedSlots?.accent
                            ? 'bg-[#131D29] border border-[#22D3EE] swatch-apply-pulse'
                            : 'bg-[#0B0D10] border border-[#2A3342] hover:border-[#22D3EE]/55'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1 text-xs text-[#D5DCE6] whitespace-nowrap">
                          Accent
                          {flashedSlots?.accent && (
                            <Check className="w-3 h-3 text-[#34D399]" aria-hidden="true" />
                          )}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCopyHex(project.brand.palette.accent)}
                            title={`Copy ${project.brand.palette.accent.toUpperCase()}`}
                            className="font-mono text-[11px] text-[#8C96A8] hover:text-[#67E8F9] tabular-nums transition-colors cursor-pointer"
                          >
                            {copiedHex === project.brand.palette.accent.toUpperCase()
                              ? 'Copied'
                              : project.brand.palette.accent.toUpperCase()}
                          </button>
                          <input
                            type="color"
                            aria-label="Pick accent brand color"
                            value={project.brand.palette.accent}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                brand: {
                                  ...p.brand,
                                  palette: {
                                    primary: p.brand.palette.primary,
                                    accent: e.target.value.toUpperCase(),
                                    canvasMode: p.brand.palette.canvasMode,
                                  },
                                },
                              }))
                            }
                            className="w-6 h-6 bg-transparent border-0 cursor-pointer"
                          />
                        </span>
                      </div>
                    </div>

                    {/* Real-Time WCAG Contrast Checker & Fix Contrast Control */}
                    <div
                      className={`p-3 bg-[#0B0D10] border rounded-md space-y-2.5 transition-[border-color,box-shadow] duration-200 ${
                        contrastFixedFeedback
                          ? 'border-[#34D399]/70 swatch-apply-pulse'
                          : contrastAudit.allPassAA
                            ? 'border-[#222833]'
                            : 'border-[#FBBF24]/45'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                            {contrastAudit.allPassAA ? (
                              <CheckCircle2
                                className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                                aria-hidden="true"
                              />
                            ) : (
                              <AlertTriangle
                                className="w-3.5 h-3.5 text-[#FBBF24] shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span
                              className={
                                contrastAudit.allPassAA ? 'text-[#34D399]' : 'text-[#FBBF24]'
                              }
                            >
                              WCAG {contrastAudit.statusLabel}
                            </span>
                            <span className="text-[#4B5565]" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-[#D5DCE6] tabular-nums">
                              {contrastAudit.passedCount}/{contrastAudit.totalCount}{' '}
                              {contrastAudit.overallGrade === 'AAA' ? 'AAA' : 'AA'}
                            </span>
                          </div>
                          <p className="text-[10px] font-mono text-[#8C96A8] tabular-nums mt-0.5">
                            Pair ratio {formatContrastRatio(contrastAudit.pairRatio)} · Score{' '}
                            {contrastAudit.scorePercent}%
                          </p>
                        </div>

                        {!contrastAudit.allPassAA ? (
                          <button
                            type="button"
                            onClick={handleAutoFixContrast}
                            className="swatch-interactive h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Wand2 className="w-3 h-3" aria-hidden="true" />
                            Fix Contrast
                          </button>
                        ) : contrastFixedFeedback ? (
                          <span
                            role="status"
                            aria-live="polite"
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#34D399] whitespace-nowrap shrink-0"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            Fixed
                          </span>
                        ) : null}
                      </div>

                      <div className="space-y-1.5 pt-1 border-t border-[#1A202B]">
                        {contrastAudit.checks.map((chk) => (
                          <div
                            key={chk.id}
                            className="flex items-center justify-between gap-2 text-[11px]"
                          >
                            <span className="inline-flex items-center gap-1.5 min-w-0 text-[#A0AABB]">
                              <span
                                className="w-5 h-4 rounded-xs border border-white/15 inline-flex items-center justify-center text-[9px] font-bold shrink-0"
                                style={{
                                  backgroundColor: chk.bgHex,
                                  color: chk.fgHex,
                                }}
                                title={`Text ${chk.fgHex} on ${chk.bgHex}`}
                                aria-hidden="true"
                              >
                                Aa
                              </span>
                              <span className="truncate">{chk.label}</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums shrink-0">
                              <span className="text-[#D5DCE6]">
                                {formatContrastRatio(chk.ratio)}
                              </span>
                              <span
                                className={
                                  chk.passesAA ? 'text-[#34D399]' : 'text-[#FCA5A5]'
                                }
                              >
                                {chk.passesAAA
                                  ? 'Pass AAA'
                                  : chk.passesAA
                                    ? 'Pass AA'
                                    : 'Fail'}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>

                      {contrastAudit.hasTextOverrides && (
                        <div className="pt-1.5 border-t border-[#1A202B] flex items-center justify-between gap-2 text-[10px]">
                          <span className="text-[#8C96A8]">
                            Text colors tuned for WCAG AA (brand swatches kept)
                          </span>
                          <button
                            type="button"
                            onClick={handleResetTextColors}
                            className="text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Reset text
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Gemini Brand Swatch Library */}
                    <div className="pt-2 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#F5F7FA]">
                          Brand Swatch Library
                        </span>
                        <button
                          type="button"
                          disabled={isExtractingColors}
                          onClick={handleExtractBrandColors}
                          className="swatch-interactive h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/50 hover:border-[#22D3EE] hover:bg-[#1D2A3A] disabled:opacity-50 rounded whitespace-nowrap cursor-pointer"
                        >
                          {isExtractingColors ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                              Scanning...
                            </>
                          ) : (
                            <>
                              <Pipette className="w-3 h-3" aria-hidden="true" />
                              Extract Colors
                            </>
                          )}
                        </button>
                      </div>

                      {colorExtractError && (
                        <p role="alert" className="text-[11px] text-[#FCA5A5] leading-relaxed">
                          {colorExtractError}
                        </p>
                      )}

                      {project.brandSwatches && project.brandSwatches.length > 0 ? (
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div
                              role="group"
                              aria-label="Swatch click mode"
                              className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#222833] rounded"
                            >
                              {(
                                [
                                  { id: 'primary', label: 'Primary' },
                                  { id: 'accent', label: 'Accent' },
                                  { id: 'copy', label: 'Copy' },
                                ] as const
                              ).map((mode) => (
                                <button
                                  key={mode.id}
                                  type="button"
                                  aria-pressed={swatchApplyTarget === mode.id}
                                  onClick={() => setSwatchApplyTarget(mode.id)}
                                  className={`px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer ${
                                    swatchApplyTarget === mode.id
                                      ? 'bg-[#18212E] text-[#67E8F9]'
                                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                                  }`}
                                >
                                  {mode.label}
                                </button>
                              ))}
                            </div>

                            {effectiveSuggestedPair && (() => {
                              const isSuggestedJustApplied =
                                appliedPairFeedback?.id === 'suggested';
                              const isSuggestedActive =
                                project.brand.palette.primary.toUpperCase() ===
                                  effectiveSuggestedPair.primary.toUpperCase() &&
                                project.brand.palette.accent.toUpperCase() ===
                                  effectiveSuggestedPair.accent.toUpperCase();
                              return (
                                <button
                                  type="button"
                                  onClick={handleApplySuggestedPair}
                                  className={`group swatch-interactive h-7 px-2 inline-flex items-center gap-1.5 text-[11px] font-medium rounded border whitespace-nowrap cursor-pointer ${
                                    isSuggestedJustApplied
                                      ? 'bg-[#132422] text-[#34D399] border-[#34D399]/70 swatch-apply-pulse'
                                      : isSuggestedActive
                                        ? 'bg-[#131C26] text-[#67E8F9] border-[#22D3EE]/70'
                                        : 'bg-[#0B0D10] text-[#67E8F9] border-[#22D3EE]/40 hover:border-[#22D3EE] hover:bg-[#131C26]'
                                  }`}
                                >
                                  <span
                                    className="inline-flex items-center -space-x-1 shrink-0"
                                    aria-hidden="true"
                                  >
                                    <span
                                      className="w-3 h-3 rounded-xs border border-white/25 transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-x-0.5 group-hover:scale-110"
                                      style={{ backgroundColor: effectiveSuggestedPair.primary }}
                                    />
                                    <span
                                      className="w-3 h-3 rounded-xs border border-white/25 transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 group-hover:scale-110"
                                      style={{ backgroundColor: effectiveSuggestedPair.accent }}
                                    />
                                  </span>
                                  {isSuggestedJustApplied ? (
                                    <>
                                      <Check className="w-3 h-3 text-[#34D399]" aria-hidden="true" />
                                      Pair Applied
                                    </>
                                  ) : (
                                    <span>Apply Pair</span>
                                  )}
                                </button>
                              );
                            })()}
                          </div>

                          <div className="flex items-center justify-between gap-2 text-[11px] min-h-[16px]">
                            <span className="text-[#8C96A8] truncate">
                              {swatchApplyTarget === 'copy'
                                ? 'Click any swatch to copy its hex code'
                                : `Click swatch to set ${swatchApplyTarget} & copy hex`}
                            </span>
                            {copiedHex && (
                              <span
                                role="status"
                                aria-live="polite"
                                className="inline-flex items-center gap-1.5 font-mono text-[#34D399] tabular-nums shrink-0"
                              >
                                <span
                                  className="w-2.5 h-2.5 rounded-xs border border-white/25 shrink-0"
                                  style={{ backgroundColor: copiedHex }}
                                  aria-hidden="true"
                                />
                                Copied {copiedHex}
                              </span>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            {project.brandSwatches.map((sw) => {
                              const normalizedHex = sw.hex.toUpperCase();
                              const isPrimary =
                                project.brand.palette.primary.toUpperCase() === normalizedHex;
                              const isAccent =
                                project.brand.palette.accent.toUpperCase() === normalizedHex;
                              const isActive = isPrimary || isAccent;
                              const isCopied = copiedHex === normalizedHex;
                              const justApplied =
                                appliedSwatchFeedback?.hex === normalizedHex
                                  ? appliedSwatchFeedback
                                  : null;
                              const activeSlotText =
                                isPrimary && isAccent
                                  ? 'Primary · Accent'
                                  : isPrimary
                                    ? 'Primary'
                                    : isAccent
                                      ? 'Accent'
                                      : '';
                              return (
                                <div
                                  key={sw.hex}
                                  data-active={isActive ? 'true' : 'false'}
                                  title={`${sw.name} (${normalizedHex}) — ${sw.usageNote}`}
                                  className={`group swatch-interactive rounded-md overflow-hidden border ${
                                    justApplied
                                      ? 'bg-[#131D29] border-[#22D3EE] ring-1 ring-[#22D3EE]/55 swatch-apply-pulse'
                                      : isActive
                                        ? 'bg-[#131D29] border-[#22D3EE] ring-1 ring-[#22D3EE]/40 shadow-[0_6px_14px_-6px_rgba(34,211,238,0.3)]'
                                        : 'bg-[#0B0D10] border-[#222833] hover:border-[#22D3EE]/70'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    aria-pressed={isActive}
                                    onClick={() => handleApplySwatch(normalizedHex)}
                                    className="w-full text-left cursor-pointer block focus-visible:outline-none"
                                  >
                                    <div className="relative h-10 w-full overflow-hidden border-b border-white/10">
                                      <div
                                        className="absolute inset-0 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.06]"
                                        style={{ backgroundColor: normalizedHex }}
                                      />
                                      {isActive && (
                                        <span className="absolute top-0 right-0 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-[#67E8F9] bg-[#0B0D10]/85 border-b border-l border-[#22D3EE]/50 rounded-bl">
                                          <Check className="w-2.5 h-2.5 text-[#22D3EE]" aria-hidden="true" />
                                          {activeSlotText}
                                        </span>
                                      )}
                                      <div
                                        className={`absolute inset-0 z-20 flex items-center justify-center bg-[#0B0D10]/65 backdrop-blur-[1px] transition-opacity duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                                          justApplied || isCopied
                                            ? 'opacity-100'
                                            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                                        }`}
                                      >
                                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide text-[#F5F7FA] whitespace-nowrap">
                                          {justApplied ? (
                                            <>
                                              <Check
                                                className="w-3 h-3 text-[#34D399]"
                                                aria-hidden="true"
                                              />
                                              {justApplied.slot === 'copy'
                                                ? `Copied ${normalizedHex}`
                                                : justApplied.copied
                                                  ? 'Applied · Copied'
                                                  : 'Applied'}
                                            </>
                                          ) : isCopied ? (
                                            <>
                                              <Check
                                                className="w-3 h-3 text-[#34D399]"
                                                aria-hidden="true"
                                              />
                                              Copied {normalizedHex}
                                            </>
                                          ) : swatchApplyTarget === 'copy' ? (
                                            <>
                                              <Copy className="w-2.5 h-2.5 text-[#67E8F9]" aria-hidden="true" />
                                              Copy {normalizedHex}
                                            </>
                                          ) : (
                                            <>
                                              Set {swatchApplyTarget === 'primary' ? 'Primary' : 'Accent'} &amp; Copy
                                            </>
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="px-2 pt-1.5 pb-1">
                                      <p
                                        className={`text-[11px] font-medium transition-colors duration-150 truncate ${
                                          isActive
                                            ? 'text-[#67E8F9]'
                                            : 'text-[#F5F7FA] group-hover:text-[#67E8F9]'
                                        }`}
                                      >
                                        {sw.name}
                                      </p>
                                      <p
                                        className={`font-mono text-[10px] tabular-nums truncate ${
                                          isActive ? 'text-[#D5DCE6]' : 'text-[#8C96A8]'
                                        }`}
                                      >
                                        {normalizedHex} · {sw.role}
                                      </p>
                                    </div>
                                  </button>
                                  <div className="px-2 pb-1.5 flex items-center justify-between gap-1 text-[10px]">
                                    <span
                                      className={`font-medium truncate transition-colors duration-150 ${
                                        justApplied || isCopied
                                          ? 'text-[#34D399]'
                                          : isActive
                                            ? 'text-[#67E8F9]'
                                            : 'text-[#6E788A]'
                                      }`}
                                    >
                                      {justApplied
                                        ? justApplied.slot === 'copy'
                                          ? 'Hex copied'
                                          : `Active ${justApplied.slot === 'primary' ? 'Primary' : 'Accent'}`
                                        : isActive
                                          ? `Active ${activeSlotText}`
                                          : 'Click to apply'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleCopyHex(normalizedHex)}
                                      aria-label={`Copy ${normalizedHex}`}
                                      className={`inline-flex items-center gap-1 transition-colors duration-150 shrink-0 cursor-pointer ${
                                        isCopied
                                          ? 'text-[#34D399]'
                                          : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                                      }`}
                                    >
                                      {isCopied ? (
                                        <>
                                          <Check className="w-2.5 h-2.5 text-[#34D399]" />
                                          Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-2.5 h-2.5" />
                                          Copy
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] text-[#8C96A8] leading-relaxed bg-[#0B0D10] border border-[#1F2532] rounded-md px-2.5 py-2">
                          Paste a website URL in the top bar and click <strong className="text-[#D5DCE6]">Extract Colors</strong> to pull its dominant brand swatches with Gemini without overwriting your copy.
                        </p>
                      )}
                    </div>

                    {/* Curated Industry Color Pairs */}
                    <div className="pt-1 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[#8C96A8]">
                          Industry Color Pairs
                        </span>
                        {appliedPairFeedback && (
                          <span
                            role="status"
                            aria-live="polite"
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#34D399]"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            {appliedPairFeedback.label} applied
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {PALETTE_PRESETS.map((preset) => {
                          const isPresetActive =
                            project.brand.palette.primary.toUpperCase() ===
                              preset.primary.toUpperCase() &&
                            project.brand.palette.accent.toUpperCase() ===
                              preset.accent.toUpperCase() &&
                            project.brand.palette.canvasMode === preset.canvasMode;
                          const isPresetJustApplied =
                            appliedPairFeedback?.id === preset.id;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              aria-pressed={isPresetActive}
                              onClick={() =>
                                handleApplyColorPair(preset.id, preset.label, {
                                  primary: preset.primary,
                                  accent: preset.accent,
                                  canvasMode: preset.canvasMode,
                                })
                              }
                              className={`group swatch-interactive p-2 text-left rounded-md border cursor-pointer ${
                                isPresetJustApplied
                                  ? 'bg-[#131C26] border-[#22D3EE] swatch-apply-pulse'
                                  : isPresetActive
                                    ? 'bg-[#131C26] border-[#22D3EE] shadow-[0_0_0_1px_rgba(34,211,238,0.2)]'
                                    : 'bg-[#0B0D10] border-[#222833] hover:border-[#22D3EE]/70 hover:bg-[#11161E]'
                              }`}
                            >
                              <div className="relative h-5 w-full flex overflow-hidden rounded-xs border border-white/15 mb-1.5">
                                <span
                                  className="h-full w-[64%] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105"
                                  style={{ backgroundColor: preset.primary }}
                                />
                                <span
                                  className="h-full w-[36%] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105"
                                  style={{ backgroundColor: preset.accent }}
                                />
                                <span
                                  className={`absolute inset-0 flex items-center justify-center bg-[#0B0D10]/55 text-[10px] font-semibold text-[#F5F7FA] transition-opacity duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                                    isPresetJustApplied
                                      ? 'opacity-100'
                                      : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
                                  }`}
                                >
                                  {isPresetJustApplied ? (
                                    <span className="inline-flex items-center gap-1 text-[#34D399]">
                                      <Check className="w-2.5 h-2.5" aria-hidden="true" />
                                      Applied
                                    </span>
                                  ) : (
                                    'Apply pair'
                                  )}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-1">
                                <span
                                  className={`text-[11px] font-medium leading-tight truncate transition-colors duration-150 ${
                                    isPresetActive || isPresetJustApplied
                                      ? 'text-[#67E8F9]'
                                      : 'text-[#D5DCE6] group-hover:text-[#F5F7FA]'
                                  }`}
                                >
                                  {preset.label}
                                </span>
                                {isPresetActive && !isPresetJustApplied && (
                                  <Check
                                    className="w-3 h-3 text-[#22D3EE] shrink-0"
                                    aria-hidden="true"
                                  />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Typography Mood */}
                  <div className="pt-4 border-t border-[#1F2532]">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-semibold text-[#F5F7FA]">
                        Typography Style
                      </span>
                      <button
                        type="button"
                        onClick={() => setInspectorTab('typography')}
                        className="text-[11px] font-medium text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
                      >
                        Font Pairings &rarr;
                      </button>
                    </div>
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
                          onClick={() => handleSelectFontMood(mood.id)}
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

                  {/* Drag-and-Drop Page Section Order & Visibility */}
                  <div className="pt-4 border-t border-[#1F2532] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#F5F7FA]">
                        Page Sections
                      </span>
                      {isCustomSectionOrder ? (
                        <button
                          type="button"
                          onClick={handleResetSectionOrder}
                          className="text-[11px] font-medium text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
                        >
                          Reset order
                        </button>
                      ) : (
                        <span className="text-[11px] text-[#6E788A]">
                          Drag · Hide · Lock
                        </span>
                      )}
                    </div>

                    <div className="space-y-1.5" role="list" aria-label="Reorderable mockup sections">
                      {orderedSections.map((secKey, idx) => {
                        const labelMap: Record<MockupSectionKey, string> = {
                          services: 'Core Services Grid',
                          projects: 'Recent Projects & Outcomes',
                          about: 'About & Credentials',
                          quote: 'Interactive Quote Form',
                        };
                        const isVisible = project.sectionVisibility[secKey];
                        const isLocked = Boolean(lockedSections[secKey]);
                        const unlockedKeys = orderedSections.filter((k) => !lockedSections[k]);
                        const unlockedPos = unlockedKeys.indexOf(secKey);
                        const canMoveUp = !isLocked && unlockedPos > 0;
                        const canMoveDown =
                          !isLocked &&
                          unlockedPos !== -1 &&
                          unlockedPos < unlockedKeys.length - 1;
                        const isDragging = draggedSectionKey === secKey;
                        const isDropTarget =
                          dragOverSectionKey === secKey &&
                          draggedSectionKey !== secKey &&
                          !isLocked;
                        return (
                          <div
                            key={secKey}
                            role="listitem"
                            draggable={!isLocked}
                            onDragStart={(e) => handleInspectorDragStart(e, secKey)}
                            onDragOver={(e) => handleInspectorDragOver(e, secKey)}
                            onDragLeave={() =>
                              setDragOverSectionKey((curr) => (curr === secKey ? null : curr))
                            }
                            onDrop={(e) => handleInspectorDrop(e, secKey)}
                            onDragEnd={handleInspectorDragEnd}
                            className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-md border transition-[transform,border-color,background-color,opacity,box-shadow] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] select-none ${
                              isLocked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
                            } ${
                              isDragging
                                ? 'opacity-45 bg-[#131D29] border-[#22D3EE]/50'
                                : isDropTarget
                                  ? 'bg-[#131D29] border-[#22D3EE] ring-1 ring-[#22D3EE]/45'
                                  : isLocked
                                    ? 'bg-[#12151C] border-[#F59E0B]/35'
                                    : isVisible
                                      ? 'bg-[#0B0D10] border-[#222833] hover:border-[#22D3EE]/60'
                                      : 'bg-[#0B0D10]/60 border-[#1C212B] opacity-70 hover:border-[#2A3342]'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {isLocked ? (
                                <Lock
                                  className="w-3 h-3 text-[#F59E0B] shrink-0"
                                  aria-hidden="true"
                                />
                              ) : (
                                <GripVertical
                                  className="w-3.5 h-3.5 text-[#6E788A] shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="font-mono text-[10px] text-[#6E788A] tabular-nums shrink-0">
                                {String(idx + 1).padStart(2, '0')}.
                              </span>
                              <span
                                className={`text-xs truncate ${
                                  isVisible ? 'text-[#D5DCE6]' : 'text-[#6E788A] line-through'
                                }`}
                              >
                                {labelMap[secKey]}
                              </span>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                disabled={!canMoveUp}
                                onClick={() => handleNudgeSection(idx, -1)}
                                aria-label={`Move ${labelMap[secKey]} up`}
                                className="p-1 text-[#8C96A8] hover:text-[#67E8F9] disabled:opacity-25 transition-colors cursor-pointer"
                              >
                                <ArrowUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                disabled={!canMoveDown}
                                onClick={() => handleNudgeSection(idx, 1)}
                                aria-label={`Move ${labelMap[secKey]} down`}
                                className="p-1 text-[#8C96A8] hover:text-[#67E8F9] disabled:opacity-25 transition-colors cursor-pointer"
                              >
                                <ArrowDown className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleToggleSectionLock(secKey)}
                                aria-label={
                                  isLocked
                                    ? `Unlock ${labelMap[secKey]}`
                                    : `Lock ${labelMap[secKey]}`
                                }
                                aria-pressed={isLocked}
                                className={`p-1 rounded transition-colors cursor-pointer ${
                                  isLocked
                                    ? 'text-[#F59E0B] hover:text-[#FDE68A]'
                                    : 'text-[#6E788A] hover:text-[#F5F7FA]'
                                }`}
                              >
                                {isLocked ? (
                                  <Lock className="w-3 h-3" />
                                ) : (
                                  <Unlock className="w-3 h-3" />
                                )}
                              </button>
                              <input
                                type="checkbox"
                                disabled={isLocked}
                                aria-label={`Show ${labelMap[secKey]}`}
                                checked={isVisible}
                                onChange={() => handleToggleSectionVisibility(secKey)}
                                className="accent-[#22D3EE] w-4 h-4 ml-0.5 cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* TYPOGRAPHY & GOOGLE FONT PAIRINGS TAB */}
              {inspectorTab === 'typography' && (
                <MockupTypographyPanel
                  project={project}
                  urlInput={urlInput}
                  onUrlInputChange={setUrlInput}
                  detectedSiteFonts={detectedSiteFonts}
                  isSuggestingFonts={isSuggestingFonts}
                  fontSuggestError={fontSuggestError}
                  appliedPairingFeedback={appliedPairingFeedback}
                  onSuggestFonts={handleSuggestFontPairings}
                  onApplyPairing={handleApplyFontPairing}
                  onSelectCustomFont={handleSelectCustomFont}
                  onSelectMood={handleSelectFontMood}
                  onResetTypography={handleResetTypography}
                />
              )}

              {/* UNIFIED LOGO, SITE PHOTOS & CLIENT HANDOVER ZIP TAB */}
              {inspectorTab === 'media' && (
                <div className="space-y-5">
                  <MockupHandoverHeader
                    handoverAssets={handoverAssets}
                    totalMediaKb={totalMediaKb}
                    isExportingZip={isExportingZip}
                    exportedZipInfo={exportedZipInfo}
                    zipError={zipError}
                    onExportZip={handleExportAssetsZip}
                  />

                  {mediaError && (
                    <p role="alert" className="text-xs text-[#FCA5A5]">
                      {mediaError}
                    </p>
                  )}

                  <MockupImageDropzone
                    label="Company Logo"
                    helperText="Max 480×200"
                    variant="logo"
                    dataUrl={project.brand.logoDataUrl}
                    isCompressing={uploadingSlot === 'logo'}
                    compressionMeta={compressionMetaBySlot.logo}
                    onSelectFile={handleLogoFile}
                    onRemove={() =>
                      updateProject((p) => ({
                        ...p,
                        brand: { ...p.brand, logoDataUrl: undefined },
                      }))
                    }
                  />

                  <div className="pt-3 border-t border-[#1F2532]">
                    <MockupImageDropzone
                      label="Hero Site Photo"
                      helperText="Max 1200×900"
                      variant="photo"
                      dataUrl={project.hero.photoDataUrl}
                      isCompressing={uploadingSlot === 'hero'}
                      compressionMeta={compressionMetaBySlot.hero}
                      onSelectFile={handleHeroPhotoFile}
                      onRemove={() =>
                        updateProject((p) => ({
                          ...p,
                          hero: { ...p.hero, photoDataUrl: undefined },
                        }))
                      }
                    />
                  </div>

                  <div className="pt-3 border-t border-[#1F2532] space-y-3.5">
                    <span className="block text-xs font-semibold text-[#F5F7FA]">
                      Completed Project Photos ({project.projects.length})
                    </span>
                    {project.projects.map((prj, idx) => (
                      <MockupImageDropzone
                        key={prj.id}
                        label={`${String(idx + 1).padStart(2, '0')}. ${prj.title || 'Project'}`}
                        helperText={prj.location}
                        variant="photo"
                        dataUrl={prj.photoDataUrl}
                        isCompressing={uploadingSlot === prj.id}
                        compressionMeta={compressionMetaBySlot[prj.id]}
                        onSelectFile={(file) => handleProjectPhotoFile(prj.id, file)}
                        onRemove={() =>
                          updateProject((p) => ({
                            ...p,
                            projects: p.projects.map((x) =>
                              x.id === prj.id ? { ...x, photoDataUrl: undefined } : x
                            ),
                          }))
                        }
                      />
                    ))}
                  </div>

                  <MockupMediaCollectionPanel
                    project={project}
                    collectionUploadProgress={collectionUploadProgress}
                    onAddCollectionFiles={handleAddCollectionFiles}
                    onRenameAsset={handleRenameCollectionAsset}
                    onChangeAssetCategory={handleChangeCollectionAssetCategory}
                    onAssignAssetToSlot={handleAssignCollectionAssetToSlot}
                    onDeleteCollectionAsset={handleDeleteCollectionAsset}
                    onSyncActiveSlotsToCollection={handleSyncActiveSlotsToCollection}
                  />
                </div>
              )}

              {/* HERO TAB */}
              {inspectorTab === 'hero' && (
                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Eyebrow Kicker
                    </label>
                    <input
                      type="text"
                      value={project.hero.kicker}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          hero: { ...p.hero, kicker: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Main Headline
                    </label>
                    <textarea
                      rows={2}
                      value={project.hero.headline}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          hero: { ...p.hero, headline: e.target.value },
                        }))
                      }
                      className="w-full p-2.5 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Subheadline
                    </label>
                    <textarea
                      rows={3}
                      value={project.hero.subheadline}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          hero: { ...p.hero, subheadline: e.target.value },
                        }))
                      }
                      className="w-full p-2.5 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md leading-relaxed"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                        Primary CTA
                      </label>
                      <input
                        type="text"
                        value={project.hero.primaryCta}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            hero: { ...p.hero, primaryCta: e.target.value },
                          }))
                        }
                        className="w-full h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                        Secondary CTA
                      </label>
                      <input
                        type="text"
                        value={project.hero.secondaryCta}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            hero: { ...p.hero, secondaryCta: e.target.value },
                          }))
                        }
                        className="w-full h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Trust Highlights (one per line)
                    </label>
                    <textarea
                      rows={3}
                      value={project.hero.trustHighlights.join('\n')}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          hero: {
                            ...p.hero,
                            trustHighlights: e.target.value.split('\n'),
                          },
                        }))
                      }
                      className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                    />
                  </div>

                  {/* Hero Site Photo Dropzone (Hidden Canvas Compression) */}
                  <div className="pt-2 border-t border-[#1F2532]">
                    <MockupImageDropzone
                      label="Hero Site Photo"
                      helperText="Split hero showcase"
                      variant="photo"
                      dataUrl={project.hero.photoDataUrl}
                      isCompressing={uploadingSlot === 'hero'}
                      compressionMeta={compressionMetaBySlot.hero}
                      onSelectFile={handleHeroPhotoFile}
                      onRemove={() =>
                        updateProject((p) => ({
                          ...p,
                          hero: { ...p.hero, photoDataUrl: undefined },
                        }))
                      }
                    />
                    {mediaError && inspectorTab === 'hero' && (
                      <p role="alert" className="mt-1 text-[11px] text-[#FCA5A5]">
                        {mediaError}
                      </p>
                    )}
                  </div>

                  {/* AI Polish Hero */}
                  <div className="pt-3 border-t border-[#1F2532] space-y-2">
                    <span className="block text-xs font-semibold text-[#67E8F9]">
                      AI Polish Hero Copy
                    </span>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={polishInstruction}
                        onChange={(e) => setPolishInstruction(e.target.value)}
                        placeholder="e.g., Sound more direct for commercial builders"
                        className="flex-1 min-w-0 h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md"
                      />
                      <button
                        type="button"
                        disabled={Boolean(isPolishingSection) || !polishInstruction.trim()}
                        onClick={() => handlePolishSection('hero')}
                        className="h-9 px-3 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md whitespace-nowrap cursor-pointer"
                      >
                        {isPolishingSection === 'hero' ? '...' : 'Polish'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        'Make headline sharper and shorter',
                        'Speak to local homeowners',
                      ].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={Boolean(isPolishingSection)}
                          onClick={() => handlePolishSection('hero', preset)}
                          className="text-[11px] text-[#A0AABB] hover:text-[#67E8F9] underline underline-offset-2 cursor-pointer"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    {polishError && <p className="text-xs text-[#FCA5A5]">{polishError}</p>}
                  </div>
                </div>
              )}

              {/* SERVICES TAB */}
              {inspectorTab === 'services' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#F5F7FA]">
                      Services ({project.services.length})
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        updateProject((p) => ({
                          ...p,
                          services: [
                            ...p.services,
                            {
                              id: `srv-${Date.now()}`,
                              title: 'New Service',
                              description: 'Describe what is included and why clients book it.',
                              deliverable: 'Clear turnaround & tidy handover',
                            },
                          ],
                        }))
                      }
                      className="h-7 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 rounded cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      Add Service
                    </button>
                  </div>

                  {project.services.map((srv, idx) => (
                    <div
                      key={srv.id}
                      className="p-3 bg-[#0B0D10] border border-[#222833] rounded-md space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-[#22D3EE]">
                          {String(idx + 1).padStart(2, '0')}.
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() =>
                              updateProject((p) => ({
                                ...p,
                                services: moveItem(p.services, idx, idx - 1),
                              }))
                            }
                            aria-label="Move service up"
                            className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === project.services.length - 1}
                            onClick={() =>
                              updateProject((p) => ({
                                ...p,
                                services: moveItem(p.services, idx, idx + 1),
                              }))
                            }
                            aria-label="Move service down"
                            className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateProject((p) => ({
                                ...p,
                                services: p.services.filter((s) => s.id !== srv.id),
                              }))
                            }
                            aria-label="Remove service"
                            className="p-1 text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={srv.title}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            services: p.services.map((s) =>
                              s.id === srv.id ? { ...s, title: e.target.value } : s
                            ),
                          }))
                        }
                        className="w-full h-8 px-2.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] rounded"
                      />
                      <textarea
                        rows={2}
                        value={srv.description}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            services: p.services.map((s) =>
                              s.id === srv.id ? { ...s, description: e.target.value } : s
                            ),
                          }))
                        }
                        className="w-full p-2 text-xs text-[#D5DCE6] bg-[#13161C] border border-[#2A3342] rounded leading-relaxed"
                      />
                      <input
                        type="text"
                        value={srv.deliverable}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            services: p.services.map((s) =>
                              s.id === srv.id ? { ...s, deliverable: e.target.value } : s
                            ),
                          }))
                        }
                        placeholder="Included deliverable / spec line"
                        className="w-full h-8 px-2.5 text-[11px] text-[#A0AABB] bg-[#13161C] border border-[#2A3342] rounded"
                      />
                    </div>
                  ))}

                  <div className="pt-2 border-t border-[#1F2532] flex gap-1.5">
                    <input
                      type="text"
                      value={polishInstruction}
                      onChange={(e) => setPolishInstruction(e.target.value)}
                      placeholder="AI polish services (e.g. tighten descriptions)"
                      className="flex-1 min-w-0 h-9 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                    <button
                      type="button"
                      disabled={Boolean(isPolishingSection) || !polishInstruction.trim()}
                      onClick={() => handlePolishSection('services')}
                      className="h-9 px-3 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md cursor-pointer"
                    >
                      {isPolishingSection === 'services' ? '...' : 'Polish'}
                    </button>
                  </div>
                  {polishError && <p className="text-xs text-[#FCA5A5]">{polishError}</p>}
                </div>
              )}

              {/* PROOF & ABOUT TAB */}
              {inspectorTab === 'proof' && (
                <div className="space-y-5">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#F5F7FA]">
                        Completed Projects ({project.projects.length})
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updateProject((p) => ({
                            ...p,
                            projects: [
                              ...p.projects,
                              {
                                id: `prj-${Date.now()}`,
                                title: 'New Featured Job',
                                location: p.brand.serviceArea || 'Local Area',
                                metric: 'Completed on schedule',
                                summary: 'Brief note on what the job involved and the outcome.',
                              },
                            ],
                          }))
                        }
                        className="h-7 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 rounded cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        Add Job
                      </button>
                    </div>

                    {project.projects.map((prj) => (
                      <div
                        key={prj.id}
                        className="p-3 bg-[#0B0D10] border border-[#222833] rounded-md space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={prj.title}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                projects: p.projects.map((x) =>
                                  x.id === prj.id ? { ...x, title: e.target.value } : x
                                ),
                              }))
                            }
                            className="flex-1 min-w-0 h-8 px-2.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] rounded"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateProject((p) => ({
                                ...p,
                                projects: p.projects.filter((x) => x.id !== prj.id),
                              }))
                            }
                            aria-label="Remove project"
                            className="p-1 text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <input
                            type="text"
                            value={prj.location}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                projects: p.projects.map((x) =>
                                  x.id === prj.id ? { ...x, location: e.target.value } : x
                                ),
                              }))
                            }
                            placeholder="Location"
                            className="h-8 px-2 text-[11px] text-[#D5DCE6] bg-[#13161C] border border-[#2A3342] rounded"
                          />
                          <input
                            type="text"
                            value={prj.metric}
                            onChange={(e) =>
                              updateProject((p) => ({
                                ...p,
                                projects: p.projects.map((x) =>
                                  x.id === prj.id ? { ...x, metric: e.target.value } : x
                                ),
                              }))
                            }
                            placeholder="Scope / result metric"
                            className="h-8 px-2 text-[11px] text-[#67E8F9] bg-[#13161C] border border-[#2A3342] rounded"
                          />
                        </div>
                        <textarea
                          rows={2}
                          value={prj.summary}
                          onChange={(e) =>
                            updateProject((p) => ({
                              ...p,
                              projects: p.projects.map((x) =>
                                x.id === prj.id ? { ...x, summary: e.target.value } : x
                              ),
                            }))
                          }
                          className="w-full p-2 text-xs text-[#A0AABB] bg-[#13161C] border border-[#2A3342] rounded leading-relaxed"
                        />

                        {/* Project Job Photo Upload */}
                        {prj.photoDataUrl ? (
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <img
                                src={prj.photoDataUrl}
                                alt={prj.title}
                                className="w-12 h-8 object-cover rounded border border-[#2A3342] shrink-0"
                              />
                              <span className="font-mono text-[10px] text-[#8C96A8] tabular-nums">
                                {estimateDataUrlKb(prj.photoDataUrl)} KB
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <label className="text-[11px] font-medium text-[#67E8F9] hover:underline cursor-pointer">
                                Change
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={(ev) => handleUploadProjectPhoto(prj.id, ev)}
                                  className="sr-only"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  updateProject((p) => ({
                                    ...p,
                                    projects: p.projects.map((x) =>
                                      x.id === prj.id ? { ...x, photoDataUrl: undefined } : x
                                    ),
                                  }))
                                }
                                className="text-[11px] text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ) : (
                          <label className="flex items-center justify-center gap-1.5 h-8 px-2.5 text-[11px] font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-dashed border-[#2A3342] hover:border-[#22D3EE]/55 rounded cursor-pointer">
                            {uploadingSlot === prj.id ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin text-[#22D3EE]" />
                                Compressing...
                              </>
                            ) : (
                              <>
                                <ImagePlus className="w-3 h-3 text-[#22D3EE]" />
                                Attach job photo
                              </>
                            )}
                            <input
                              type="file"
                              accept="image/*"
                              disabled={uploadingSlot === prj.id}
                              onChange={(ev) => handleUploadProjectPhoto(prj.id, ev)}
                              className="sr-only"
                            />
                          </label>
                        )}
                      </div>
                    ))}
                    {mediaError && inspectorTab === 'proof' && (
                      <p className="text-[11px] text-[#FCA5A5]">{mediaError}</p>
                    )}
                  </div>

                  {/* About Story & Credentials */}
                  <div className="pt-4 border-t border-[#1F2532] space-y-3">
                    <span className="block text-xs font-semibold text-[#F5F7FA]">
                      About &amp; Credentials
                    </span>
                    <input
                      type="text"
                      value={project.about.heading}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          about: { ...p.about, heading: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-xs font-medium text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                    <textarea
                      rows={3}
                      value={project.about.story}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          about: { ...p.about, story: e.target.value },
                        }))
                      }
                      className="w-full p-2.5 text-xs text-[#D5DCE6] bg-[#0B0D10] border border-[#2A3342] rounded-md leading-relaxed"
                    />
                    <div>
                      <label className="block text-[11px] text-[#8C96A8] mb-1">
                        Key credentials (one per line)
                      </label>
                      <textarea
                        rows={3}
                        value={project.about.credentials.join('\n')}
                        onChange={(e) =>
                          updateProject((p) => ({
                            ...p,
                            about: {
                              ...p.about,
                              credentials: e.target.value.split('\n'),
                            },
                          }))
                        }
                        className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* CONTACT & QUOTE FORM TAB */}
              {inspectorTab === 'contact' && (
                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={project.brand.phone}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          brand: { ...p.brand, phone: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-sm font-mono text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Email Address
                    </label>
                    <input
                      type="text"
                      value={project.brand.email}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          brand: { ...p.brand, email: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Yard / Office Address
                    </label>
                    <input
                      type="text"
                      value={project.brand.address}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          brand: { ...p.brand, address: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#F5F7FA] mb-1">
                      Operating Hours
                    </label>
                    <input
                      type="text"
                      value={project.brand.hours}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          brand: { ...p.brand, hours: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                  </div>

                  <div className="pt-3 border-t border-[#1F2532] space-y-3">
                    <span className="block text-xs font-semibold text-[#F5F7FA]">
                      Quote Form Copy
                    </span>
                    <input
                      type="text"
                      value={project.quoteForm.heading}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          quoteForm: { ...p.quoteForm, heading: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                    <textarea
                      rows={2}
                      value={project.quoteForm.subtext}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          quoteForm: { ...p.quoteForm, subtext: e.target.value },
                        }))
                      }
                      className="w-full p-2.5 text-xs text-[#D5DCE6] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                    <input
                      type="text"
                      value={project.quoteForm.submitLabel}
                      onChange={(e) =>
                        updateProject((p) => ({
                          ...p,
                          quoteForm: { ...p.quoteForm, submitLabel: e.target.value },
                        }))
                      }
                      className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] rounded-md"
                    />
                  </div>
                </div>
              )}

              {/* ON-SITE SCRATCHPAD NOTES TAB */}
              {inspectorTab === 'notes' && (
                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="onsite-notes-textarea"
                      className="block text-xs font-semibold text-[#F5F7FA] mb-1"
                    >
                      On-Site Scratchpad
                    </label>
                    <p className="text-[11px] text-[#8C96A8] mb-2 leading-relaxed">
                      Jot down photos to snap, wording ideas, or questions to check with your mate while waiting between pours. Auto-saved locally.
                    </p>
                    <textarea
                      id="onsite-notes-textarea"
                      rows={12}
                      value={project.siteNotes}
                      onChange={(e) =>
                        updateProject((p) => ({ ...p, siteNotes: e.target.value }))
                      }
                      placeholder="- Photos to take on site&#10;- Pricing / services to confirm&#10;- Domain & hosting notes"
                      className="w-full p-3 text-xs font-mono text-[#E4E9F1] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md leading-relaxed"
                    />
                  </div>

                  <div className="pt-2 border-t border-[#1F2532] flex items-center justify-between text-[11px] text-[#8C96A8]">
                    <span>Auto-saves offline</span>
                    <button
                      type="button"
                      onClick={handleCopyJson}
                      className="inline-flex items-center gap-1 text-[#67E8F9] hover:underline cursor-pointer"
                    >
                      {copiedJson ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copiedJson ? 'Copied spec' : 'Copy mockup JSON'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Right Full-Width Live Brand-Tailored Preview Canvas */}
        <div
          className={`flex-1 min-w-0 bg-[#080A0D] overflow-y-auto ${
            presentMode ? 'p-3 sm:p-6' : 'p-4 sm:p-6 lg:p-8'
          }`}
        >
          {isAnalyzing ? (
            <div className="max-w-3xl mx-auto my-20 bg-[#13161C] border border-[#22D3EE]/40 rounded-lg p-10 text-center space-y-3">
              <Loader2
                className="w-7 h-7 text-[#22D3EE] animate-spin mx-auto"
                aria-hidden="true"
              />
              <p className="font-serif text-xl text-[#F5F7FA]">
                Reading site branding &amp; drafting tailored mockup...
              </p>
              <p className="text-xs text-[#8C96A8]">
                Extracting business name, services, palette colours, and contact details.
              </p>
            </div>
          ) : (
            <MockupPreviewCanvas
              project={project}
              viewport={viewport}
              allowSectionDrag={!presentMode}
              lockedSections={lockedSections}
              selectedLayer={selectedLayer}
              onReorderSections={handleReorderSections}
              onSelectLayer={handleSelectLayer}
            />
          )}
        </div>

        {/* Right Collapsible Dock: Version History Sidebar or Layer Manager Sidebar */}
        {rightSidebarPanel === 'versions' && (
          <MockupVersionHistorySidebar
            project={project}
            activeContentHash={activeContentHash}
            isAuthenticated={Boolean(user)}
            cloudVersions={cloudMockups}
            localSnapshots={snapshots}
            isLoadingCloud={isLoadingCloudMockups}
            isSavingVersion={isSavingCloudMockup}
            revertingVersionId={revertingVersionId}
            errorMessage={cloudMockupError}
            revertFeedback={revertFeedback}
            onSignIn={() => void signInWithGoogle()}
            onRefreshCloud={() => void loadCloudVersions()}
            onSaveVersion={handleSaveVersion}
            onRevertCloudVersion={handleRevertCloudVersion}
            onUpdateCloudVersionMeta={handleUpdateCloudVersionMeta}
            onDeleteCloudVersion={handleDeleteCloudMockup}
            onRevertLocalSnapshot={handleRevertLocalSnapshot}
            onDeleteLocalSnapshot={(id) =>
              setSnapshots((prev) => prev.filter((s) => s.id !== id))
            }
            onUndoRevert={handleUndoRevert}
            onDismissRevertFeedback={() => setRevertFeedback(null)}
            onSwitchToLayers={
              !presentMode ? () => setRightSidebarPanel('layers') : undefined
            }
            onClose={() => setRightSidebarPanel(null)}
          />
        )}

        {!presentMode && rightSidebarPanel === 'layers' && (
          <MockupLayerManagerSidebar
            project={project}
            orderedSections={orderedSections}
            lockedSections={lockedSections}
            selectedLayer={selectedLayer}
            selectedExportSections={selectedExportSections}
            isExportingPngs={isExportingPngs}
            exportingSingleKey={exportingSingleKey}
            pngExportNotice={pngExportNotice}
            onSelectLayer={handleSelectLayer}
            onToggleExportSelection={handleToggleExportSection}
            onSelectAllExportSections={handleSelectAllVisibleExportSections}
            onClearExportSections={handleClearExportSections}
            onQuickExportSinglePng={handleQuickExportSinglePng}
            onQuickExportSelectedPngs={handleQuickExportSelectedPngs}
            onOpenPngExportModal={() => setPngExportModalOpen(true)}
            onToggleVisibility={handleToggleSectionVisibility}
            onToggleLock={handleToggleSectionLock}
            onMoveSection={handleMoveSectionWithLocks}
            onNudgeSection={handleNudgeLayerKey}
            onShowAllSections={handleShowAllSections}
            onUnlockAllSections={handleUnlockAllSections}
            onResetOrder={handleResetSectionOrder}
            onSwitchToVersions={() => setRightSidebarPanel('versions')}
            onClose={() => setRightSidebarPanel(null)}
          />
        )}
      </div>

      {/* Transparent Section PNG Exporter Modal */}
      <SectionPngExportModal
        isOpen={pngExportModalOpen}
        project={project}
        orderedSections={orderedSections}
        selectedKeys={selectedExportSections}
        onToggleSelectKey={handleToggleExportSection}
        onSelectAllVisible={handleSelectAllVisibleExportSections}
        onClearSelection={handleClearExportSections}
        onUnhideSection={(key) => {
          handleToggleSectionVisibility(key);
          setSelectedExportSections((prev) =>
            prev.includes(key) ? prev : [...prev, key]
          );
        }}
        onClose={() => setPngExportModalOpen(false)}
      />

      {/* Shareable Client Preview Link Modal */}
      <ShareMockupModal
        isOpen={shareModalOpen}
        project={project}
        onClose={() => setShareModalOpen(false)}
        onOpenPreview={(shareId) => {
          onOpenSharedMockup?.(shareId);
        }}
      />

      {/* Printable One-Page Client Pitch Summary PDF Modal */}
      <MockupPitchSheetModal
        isOpen={pitchSheetOpen}
        project={project}
        onClose={() => setPitchSheetOpen(false)}
        onExportSuccess={(result) => {
          setPitchPdfSaved(true);
          setImportNotice(
            `Saved single-page client pitch PDF (${result.filename} · ${result.sizeKb} KB)`
          );
          if (pitchPdfTimerRef.current) {
            window.clearTimeout(pitchPdfTimerRef.current);
          }
          pitchPdfTimerRef.current = window.setTimeout(() => {
            setPitchPdfSaved(false);
          }, 3200);
        }}
      />
    </div>
  );
}
