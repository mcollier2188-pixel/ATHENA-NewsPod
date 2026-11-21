import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ArrowRight,
  Box,
  Check,
  Download,
  Film,
  ImageIcon,
  Loader2,
  Music2,
  Send,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchDbMediaItems,
  generateLyriaMusic,
  generateOrAnimateVideo,
  generateOrEditImage,
  saveDbMediaItem,
  type DbMediaItemRow,
} from '../services/suiteApi';

type MediaTab = 'images' | 'video' | 'music';

export interface MediaImageTransferPayload {
  dataUrl: string;
  label: string;
  mimeType: string;
  aspectRatio?: string;
  prompt?: string;
  source?: 'generated' | 'upload';
}

export interface GeneratedSessionImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  caption: string;
  aspectRatio: string;
  prompt: string;
}

interface MediaLabViewProps {
  onSendImageToMockup: (imageDataUrl: string, label: string) => void;
  onSendImageTo3DStage: (imageDataUrl: string, label: string) => void;
  onSendVideoTo3DStage?: (
    videoUrl: string,
    label: string,
    aspectRatio?: string
  ) => void;
  stagedVideoImage?: MediaImageTransferPayload | null;
  onSendImageToVideoStage?: (payload: MediaImageTransferPayload) => void;
  onClearStagedVideoImage?: () => void;
  persistedSessionImages?: GeneratedSessionImage[];
  activeSessionImageId?: string | null;
  onSessionImagesChange?: (images: GeneratedSessionImage[]) => void;
  onActiveSessionImageChange?: (id: string | null) => void;
}

function extractMimeTypeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+);/i.exec(dataUrl);
  return match?.[1] || 'image/png';
}

function readFileAsDataUrl(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve({ dataUrl: reader.result, mimeType: file.type || 'image/png' });
      } else {
        reject(new Error('Could not read file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to load image file.'));
    reader.readAsDataURL(file);
  });
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

export function MediaLabView({
  onSendImageToMockup,
  onSendImageTo3DStage,
  onSendVideoTo3DStage,
  stagedVideoImage = null,
  onSendImageToVideoStage,
  onClearStagedVideoImage,
  persistedSessionImages,
  activeSessionImageId,
  onSessionImagesChange,
  onActiveSessionImageChange,
}: MediaLabViewProps) {
  const { user, getIdToken, signInWithGoogle } = useAuth();
  const [subTab, setSubTab] = useState<MediaTab>('images');

  // Shared Cloud SQL media history
  const [mediaHistory, setMediaHistory] = useState<DbMediaItemRow[]>([]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    getIdToken()
      .then((token) => (token ? fetchDbMediaItems(token) : []))
      .then((items) => {
        if (active) setMediaHistory(items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  const recordHistoryItem = async (payload: {
    kind: 'image' | 'video' | 'music';
    modelId: string;
    prompt: string;
    aspectRatio?: string;
    lyrics?: string;
    previewNote?: string;
  }) => {
    if (!user) return;
    try {
      const token = await getIdToken();
      if (!token) return;
      const saved = await saveDbMediaItem(token, payload);
      setMediaHistory((prev) => [saved, ...prev]);
    } catch {
      // Non-fatal history sync
    }
  };

  // ---------- 1. Image Studio (gemini-nano-banana-2.1) ----------
  const [imgPrompt, setImgPrompt] = useState(
    'Architectural dusk photograph of a cantilevered concrete and warm cedar pavilion overlooking calm water, crisp reflections, editorial lighting'
  );
  const [imgAspect, setImgAspect] = useState<'16:9' | '1:1' | '4:3' | '9:16'>('16:9');
  const [imgSize, setImgSize] = useState<'1K' | '2K'>('1K');
  const [editSourceImg, setEditSourceImg] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [localSessionImages, setLocalSessionImages] = useState<GeneratedSessionImage[]>([]);
  const [localActiveImageId, setLocalActiveImageId] = useState<string | null>(null);
  const sessionImages = persistedSessionImages ?? localSessionImages;
  const resolvedActiveImageId =
    activeSessionImageId !== undefined ? activeSessionImageId : localActiveImageId;
  const generatedImg =
    sessionImages.find((item) => item.id === resolvedActiveImageId) ??
    sessionImages[0] ??
    null;

  const selectGeneratedImage = (img: GeneratedSessionImage) => {
    if (onActiveSessionImageChange) {
      onActiveSessionImageChange(img.id);
    } else {
      setLocalActiveImageId(img.id);
    }
  };

  const pushSessionImage = (created: GeneratedSessionImage) => {
    const next = [created, ...sessionImages].slice(0, 6);
    if (onSessionImagesChange) {
      onSessionImagesChange(next);
    } else {
      setLocalSessionImages(next);
    }
    selectGeneratedImage(created);
  };

  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const transferTimerRef = useRef<number | null>(null);
  const [isGeneratingImg, setIsGeneratingImg] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (transferTimerRef.current) window.clearTimeout(transferTimerRef.current);
    };
  }, []);

  const flashTransferNotice = (message: string) => {
    setTransferNotice(message);
    if (transferTimerRef.current) window.clearTimeout(transferTimerRef.current);
    transferTimerRef.current = window.setTimeout(() => {
      setTransferNotice(null);
    }, 2800);
  };

  const handleImageSourceUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const loaded = await readFileAsDataUrl(file);
      setEditSourceImg({ ...loaded, name: file.name });
      setImgError(null);
    } catch (err) {
      setImgError(err instanceof Error ? err.message : 'Could not load source image.');
    }
  };

  const handleRunImageStudio = async (e: FormEvent) => {
    e.preventDefault();
    if (!imgPrompt.trim() || isGeneratingImg) return;
    setImgError(null);
    setIsGeneratingImg(true);
    try {
      const result = await generateOrEditImage({
        prompt: imgPrompt.trim(),
        aspectRatio: imgAspect,
        imageSize: imgSize,
        sourceImageBase64: editSourceImg?.dataUrl,
        sourceMimeType: editSourceImg?.mimeType,
      });
      const created: GeneratedSessionImage = {
        id: `img-${Date.now()}`,
        dataUrl: result.imageDataUrl,
        mimeType: extractMimeTypeFromDataUrl(result.imageDataUrl),
        caption: result.caption,
        aspectRatio: result.aspectRatio,
        prompt: imgPrompt.trim(),
      };
      pushSessionImage(created);
      void recordHistoryItem({
        kind: 'image',
        modelId: result.model,
        prompt: imgPrompt.trim(),
        aspectRatio: result.aspectRatio,
        previewNote: editSourceImg ? `Edited from ${editSourceImg.name}` : 'Generated from prompt',
      });
    } catch (err) {
      setImgError(err instanceof Error ? err.message : 'Image generation failed.');
    } finally {
      setIsGeneratingImg(false);
    }
  };

  // ---------- 2. Video Studio (gemini-omni-1.2-flash) ----------
  const [vidMode, setVidMode] = useState<'text' | 'image'>(() =>
    stagedVideoImage?.dataUrl ? 'image' : 'text'
  );
  const [vidPrompt, setVidPrompt] = useState(
    'Slow cinematic drone push-in over a misty coastal suspension bridge at blue hour, headlights streaking softly across wet asphalt'
  );
  const [vidAspect, setVidAspect] = useState<'16:9' | '9:16'>('16:9');
  const [vidDuration, setVidDuration] = useState<'4s' | '6s' | '8s'>('6s');
  const [vidResolution, setVidResolution] = useState<'720p' | '1080p'>('720p');
  const [vidSourceImg, setVidSourceImg] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string;
  } | null>(() =>
    stagedVideoImage?.dataUrl
      ? {
          dataUrl: stagedVideoImage.dataUrl,
          mimeType: stagedVideoImage.mimeType,
          name: stagedVideoImage.label,
        }
      : null
  );
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState<string | null>(null);
  const [generatedVideoMeta, setGeneratedVideoMeta] = useState<{
    aspectRatio: string;
    duration: string;
    prompt: string;
  } | null>(null);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [vidError, setVidError] = useState<string | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  // Keep local Video Animator in sync with the lifted VideoStage state hook
  useEffect(() => {
    if (!stagedVideoImage?.dataUrl) return;
    setVidSourceImg({
      dataUrl: stagedVideoImage.dataUrl,
      mimeType: stagedVideoImage.mimeType || extractMimeTypeFromDataUrl(stagedVideoImage.dataUrl),
      name: stagedVideoImage.label || 'Staged Frame',
    });
    setVidMode('image');
    if (stagedVideoImage.aspectRatio === '9:16') {
      setVidAspect('9:16');
    } else if (stagedVideoImage.aspectRatio) {
      setVidAspect('16:9');
    }
  }, [stagedVideoImage]);

  const handleTransferImageToSpatialHub = (img: GeneratedSessionImage) => {
    const label = img.prompt.slice(0, 48) || 'Generated Visual';
    onSendImageTo3DStage(img.dataUrl, label);
  };

  const handleTransferImageToVideoStage = (img: GeneratedSessionImage) => {
    const label = img.prompt.slice(0, 48) || 'Generated Studio Frame';
    const payload: MediaImageTransferPayload = {
      dataUrl: img.dataUrl,
      label,
      mimeType: img.mimeType || extractMimeTypeFromDataUrl(img.dataUrl),
      aspectRatio: img.aspectRatio,
      prompt: img.prompt,
      source: 'generated',
    };
    onSendImageToVideoStage?.(payload);
    setVidSourceImg({
      dataUrl: payload.dataUrl,
      mimeType: payload.mimeType,
      name: payload.label,
    });
    setVidMode('image');
    setVidAspect(img.aspectRatio === '9:16' ? '9:16' : '16:9');
    setVidPrompt(
      `Slow cinematic camera push-in with subtle natural light movement and depth: ${img.prompt.slice(0, 160)}`
    );
    setVidError(null);
    setSubTab('video');
  };

  const handleTransferImageToMusicMood = (img: GeneratedSessionImage) => {
    setMusicRefImg({
      dataUrl: img.dataUrl,
      mimeType: img.mimeType || extractMimeTypeFromDataUrl(img.dataUrl),
      name: img.prompt.slice(0, 40) || 'Generated Visual Mood',
    });
    setMusicError(null);
    flashTransferNotice('Visual mood attached to Music Composer');
    setSubTab('music');
  };

  const handleVideoSourceUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const loaded = await readFileAsDataUrl(file);
      const next = { ...loaded, name: file.name };
      setVidSourceImg(next);
      onSendImageToVideoStage?.({
        dataUrl: loaded.dataUrl,
        mimeType: loaded.mimeType,
        label: file.name,
        source: 'upload',
      });
      setVidMode('image');
      setVidError(null);
    } catch (err) {
      setVidError(err instanceof Error ? err.message : 'Could not load reference photo.');
    }
  };

  const handleRunVideoStudio = async (e: FormEvent) => {
    e.preventDefault();
    if (!vidPrompt.trim() || isGeneratingVideo) return;
    if (vidMode === 'image' && !vidSourceImg) {
      setVidError('Upload a photo first to animate an image into video.');
      return;
    }
    setVidError(null);
    setIsGeneratingVideo(true);
    try {
      const result = await generateOrAnimateVideo({
        prompt: vidPrompt.trim(),
        aspectRatio: vidAspect,
        duration: vidDuration,
        resolution: vidResolution,
        sourceImageBase64: vidMode === 'image' ? vidSourceImg?.dataUrl : undefined,
        sourceMimeType: vidMode === 'image' ? vidSourceImg?.mimeType : undefined,
      });

      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      const blobUrl = base64ToBlobUrl(result.videoBase64, result.mimeType || 'video/mp4');
      videoUrlRef.current = blobUrl;
      setGeneratedVideoUrl(blobUrl);
      setGeneratedVideoMeta({
        aspectRatio: result.aspectRatio,
        duration: result.duration,
        prompt: vidPrompt.trim(),
      });

      void recordHistoryItem({
        kind: 'video',
        modelId: result.model,
        prompt: vidPrompt.trim(),
        aspectRatio: result.aspectRatio,
        previewNote:
          vidMode === 'image'
            ? `Image-to-Video (${result.duration})`
            : `Text-to-Video (${result.duration})`,
      });
    } catch (err) {
      setVidError(err instanceof Error ? err.message : 'Video generation failed.');
    } finally {
      setIsGeneratingVideo(false);
    }
  };

  // ---------- 3. Music Studio (Lyria 3 Clip & Pro) ----------
  const [musicModel, setMusicModel] = useState<'lyria-3-clip-preview' | 'lyria-3-pro-preview'>(
    'lyria-3-clip-preview'
  );
  const [musicPrompt, setMusicPrompt] = useState(
    'Warm analog broadcast newsroom theme, subtle brushed percussion, upright bass pulse, Rhodes electric piano chords, 96 BPM, instrumental'
  );
  const [musicRefImg, setMusicRefImg] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [generatedMusicUrl, setGeneratedMusicUrl] = useState<string | null>(null);
  const [generatedLyrics, setGeneratedLyrics] = useState('');
  const [generatedMusicModel, setGeneratedMusicModel] = useState('');
  const [isGeneratingMusic, setIsGeneratingMusic] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const musicUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (musicUrlRef.current) URL.revokeObjectURL(musicUrlRef.current);
    };
  }, []);

  const handleMusicImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const loaded = await readFileAsDataUrl(file);
      setMusicRefImg({ ...loaded, name: file.name });
      setMusicError(null);
    } catch (err) {
      setMusicError(err instanceof Error ? err.message : 'Could not load mood image.');
    }
  };

  const handleRunMusicStudio = async (e: FormEvent) => {
    e.preventDefault();
    if (!musicPrompt.trim() || isGeneratingMusic) return;
    setMusicError(null);
    setIsGeneratingMusic(true);
    try {
      const result = await generateLyriaMusic({
        prompt: musicPrompt.trim(),
        model: musicModel,
        referenceImageBase64: musicRefImg?.dataUrl,
        referenceMimeType: musicRefImg?.mimeType,
      });

      if (musicUrlRef.current) URL.revokeObjectURL(musicUrlRef.current);
      const blobUrl = base64ToBlobUrl(result.audioBase64, result.mimeType || 'audio/wav');
      musicUrlRef.current = blobUrl;
      setGeneratedMusicUrl(blobUrl);
      setGeneratedLyrics(result.lyrics || '');
      setGeneratedMusicModel(result.model);

      void recordHistoryItem({
        kind: 'music',
        modelId: result.model,
        prompt: musicPrompt.trim(),
        lyrics: result.lyrics,
        previewNote:
          result.model === 'lyria-3-pro-preview' ? 'Full-length track' : '30-second clip',
      });
    } catch (err) {
      setMusicError(err instanceof Error ? err.message : 'Music generation failed.');
    } finally {
      setIsGeneratingMusic(false);
    }
  };

  const filteredHistory = mediaHistory.filter((item) => {
    if (subTab === 'images') return item.kind === 'image';
    if (subTab === 'video') return item.kind === 'video';
    return item.kind === 'music';
  });

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col">
      {/* Workspace Sub-Navigation */}
      <div className="bg-[#0E1116] border-b border-[#22D3EE]/20 px-5 sm:px-7 py-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {(
            [
              { id: 'images', label: 'Images · Create & Edit', icon: ImageIcon },
              { id: 'video', label: 'Video · Text & Animate', icon: Film },
              { id: 'music', label: 'Music · Lyria Studio', icon: Music2 },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = subTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubTab(tab.id)}
                className={`h-9 px-3.5 inline-flex items-center gap-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#22D3EE]/15 text-[#67E8F9] border border-[#22D3EE]/45'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {!user && (
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="text-xs text-[#8C96A8] hover:text-[#67E8F9] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign in with Google to log media history
          </button>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 max-w-6xl w-full mx-auto px-5 sm:px-7 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ---------- IMAGES TAB ---------- */}
        {subTab === 'images' && (
          <>
            <form
              onSubmit={(e) => void handleRunImageStudio(e)}
              className="lg:col-span-5 bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4"
            >
              <div>
                <p className="text-[11px] uppercase tracking-wider text-[#22D3EE] font-medium mb-1">
                  Gemini Nano Banana 2.1
                </p>
                <h2 className="font-serif text-2xl text-[#F5F7FA]">Image Studio</h2>
                <p className="text-xs text-[#8C96A8] mt-1">
                  Generate original artwork from text or upload an existing photo to edit
                  lighting, composition, or style.
                </p>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                  Optional Source Image (Edit Mode)
                </label>
                {editSourceImg ? (
                  <div className="relative bg-[#0B0D10] border border-[#22D3EE]/35 rounded-lg p-2 flex items-center gap-3">
                    <img
                      src={editSourceImg.dataUrl}
                      alt={editSourceImg.name}
                      className="w-14 h-14 object-cover rounded"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-[#F5F7FA] truncate">
                        {editSourceImg.name}
                      </p>
                      <p className="text-[11px] text-[#67E8F9]">
                        Prompt will edit this image
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditSourceImg(null)}
                      className="p-1.5 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                      title="Remove source image"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <label className="h-10 px-3.5 inline-flex items-center justify-center gap-2 w-full text-xs font-medium text-[#C7D0DF] bg-[#0B0D10] hover:bg-[#171C26] border border-dashed border-[#22D3EE]/30 rounded-lg cursor-pointer transition-colors">
                    <Upload className="w-3.5 h-3.5 text-[#22D3EE]" />
                    Upload Photo to Edit (Optional)
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => void handleImageSourceUpload(e)}
                      className="sr-only"
                    />
                  </label>
                )}
              </div>

              <div>
                <label
                  htmlFor="img-prompt"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  {editSourceImg ? 'Edit Instructions' : 'Image Prompt'}
                </label>
                <textarea
                  id="img-prompt"
                  rows={4}
                  value={imgPrompt}
                  onChange={(e) => setImgPrompt(e.target.value)}
                  placeholder="Describe the scene, camera lens, palette, or exact edits..."
                  className="w-full p-3 bg-[#0B0D10] border border-[#22D3EE]/25 focus:border-[#22D3EE] rounded-lg text-sm text-[#F5F7FA] focus:outline-none resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Aspect Ratio
                  </label>
                  <select
                    value={imgAspect}
                    onChange={(e) =>
                      setImgAspect(e.target.value as '16:9' | '1:1' | '4:3' | '9:16')
                    }
                    className="w-full h-10 px-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA]"
                  >
                    <option value="16:9">16:9 Landscape</option>
                    <option value="1:1">1:1 Square</option>
                    <option value="4:3">4:3 Editorial</option>
                    <option value="9:16">9:16 Vertical</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Resolution
                  </label>
                  <select
                    value={imgSize}
                    onChange={(e) => setImgSize(e.target.value as '1K' | '2K')}
                    className="w-full h-10 px-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA]"
                  >
                    <option value="1K">1K Fast</option>
                    <option value="2K">2K High Detail</option>
                  </select>
                </div>
              </div>

              {imgError && (
                <div className="p-3 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
                  {imgError}
                </div>
              )}

              <button
                type="submit"
                disabled={isGeneratingImg || !imgPrompt.trim()}
                className="h-11 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 text-[#071318] font-semibold text-sm rounded-lg transition-colors cursor-pointer"
              >
                {isGeneratingImg ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Rendering Image...
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4" />
                    {editSourceImg ? 'Apply Image Edit' : 'Generate Image'}
                  </>
                )}
              </button>
            </form>

            <div className="lg:col-span-7 flex flex-col gap-5">
              <div className="bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-sm font-semibold text-[#F5F7FA]">Output Preview</h3>
                    {transferNotice && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9]">
                        <Check className="w-3 h-3" aria-hidden="true" />
                        {transferNotice}
                      </span>
                    )}
                  </div>
                  {generatedImg && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() =>
                          setEditSourceImg({
                            dataUrl: generatedImg.dataUrl,
                            mimeType: generatedImg.mimeType || 'image/png',
                            name: 'Generated Output',
                          })
                        }
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs text-[#C7D0DF] bg-[#13161C] border border-white/15 hover:border-[#22D3EE]/45 rounded-md whitespace-nowrap cursor-pointer"
                      >
                        Iterate / Edit
                      </button>
                      <a
                        href={generatedImg.dataUrl}
                        download={`dispatch-image-${Date.now()}.png`}
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs text-[#C7D0DF] bg-[#13161C] border border-white/15 hover:border-[#22D3EE]/45 rounded-md whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        PNG
                      </a>
                    </div>
                  )}
                </div>

                {generatedImg ? (
                  <div className="space-y-3.5">
                    <div className="bg-[#0B0D10] rounded-lg overflow-hidden border border-white/10 flex items-center justify-center">
                      <img
                        src={generatedImg.dataUrl}
                        alt={generatedImg.prompt}
                        className="max-h-[440px] w-auto object-contain"
                      />
                    </div>
                    {generatedImg.caption && (
                      <p className="text-xs text-[#8C96A8] leading-relaxed">
                        {generatedImg.caption}
                      </p>
                    )}

                    {/* Direct Stage Transfer Bar */}
                    <div className="pt-3 border-t border-white/10 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] uppercase tracking-wider text-[#8C96A8] font-medium inline-flex items-center gap-1.5">
                          <Send className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                          Direct Stage Transfer
                        </span>
                        <span className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                          {generatedImg.aspectRatio} · Data URL Ready
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => handleTransferImageToSpatialHub(generatedImg)}
                          className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md whitespace-nowrap transition-colors cursor-pointer"
                        >
                          <Box className="w-3.5 h-3.5" aria-hidden="true" />
                          Send to 3D Stage
                          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTransferImageToVideoStage(generatedImg)}
                          className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#13161C] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md whitespace-nowrap transition-colors cursor-pointer"
                        >
                          <Film className="w-3.5 h-3.5" aria-hidden="true" />
                          Send to Video Stage
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onSendImageToMockup(
                              generatedImg.dataUrl,
                              generatedImg.prompt.slice(0, 48)
                            )
                          }
                          className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#13161C] border border-white/15 hover:border-[#22D3EE]/45 rounded-md whitespace-nowrap transition-colors cursor-pointer"
                        >
                          Use in Site Mockup
                          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTransferImageToMusicMood(generatedImg)}
                          className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#13161C] border border-white/15 hover:border-[#22D3EE]/45 rounded-md whitespace-nowrap transition-colors cursor-pointer"
                        >
                          <Music2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                          Music Mood Ref
                        </button>
                      </div>
                    </div>

                    {/* Session Captures Strip (pick any generated frame from this session to transfer) */}
                    {sessionImages.length > 1 && (
                      <div className="pt-3 border-t border-white/10">
                        <p className="text-[10px] uppercase tracking-wider text-[#8C96A8] mb-2">
                          Session Captures ({sessionImages.length})
                        </p>
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                          {sessionImages.map((item) => {
                            const selected = item.id === generatedImg.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => selectGeneratedImage(item)}
                                title={item.prompt}
                                className={`relative w-16 h-11 rounded overflow-hidden border shrink-0 transition-colors cursor-pointer ${
                                  selected
                                    ? 'border-[#22D3EE]'
                                    : 'border-white/15 opacity-70 hover:opacity-100'
                                }`}
                              >
                                <img
                                  src={item.dataUrl}
                                  alt={item.prompt}
                                  className="w-full h-full object-cover"
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-[340px] bg-[#0B0D10] border border-dashed border-white/10 rounded-lg flex flex-col items-center justify-center text-center px-6">
                    <Sparkles className="w-7 h-7 text-[#22D3EE]/70 mb-3" />
                    <p className="text-sm text-[#C7D0DF] font-medium mb-1">
                      Ready to generate or edit
                    </p>
                    <p className="text-xs text-[#8C96A8] max-w-sm">
                      Generate studio visuals and transfer them directly into 3D Stage Studio,
                      Video Stage, Site Mockup, or Music Mood Composer.
                    </p>
                  </div>
                )}
              </div>

              {filteredHistory.length > 0 && (
                <div className="bg-[#101319] border border-white/10 rounded-xl p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[#8C96A8] mb-3">
                    Recent Image Prompts
                  </h4>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {filteredHistory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setImgPrompt(item.prompt)}
                        className="w-full text-left p-2.5 bg-[#13161C] hover:bg-[#191E28] border border-white/10 rounded-lg text-xs text-[#C7D0DF] flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <span className="truncate">{item.prompt}</span>
                        <span className="text-[11px] text-[#8C96A8] shrink-0">
                          {item.aspectRatio}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ---------- VIDEO TAB ---------- */}
        {subTab === 'video' && (
          <>
            <form
              onSubmit={(e) => void handleRunVideoStudio(e)}
              className="lg:col-span-5 bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4"
            >
              <div>
                <p className="text-[11px] uppercase tracking-wider text-[#22D3EE] font-medium mb-1">
                  Gemini Omni 1.2 Flash
                </p>
                <h2 className="font-serif text-2xl text-[#F5F7FA]">Video Studio</h2>
                <p className="text-xs text-[#8C96A8] mt-1">
                  Generate short cinematic clips from text or upload any still photo to animate
                  it with camera motion.
                </p>
              </div>

              {/* Mode Switch */}
              <div className="grid grid-cols-2 gap-2 p-1 bg-[#0B0D10] border border-white/10 rounded-lg">
                <button
                  type="button"
                  onClick={() => setVidMode('text')}
                  className={`h-8 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    vidMode === 'text'
                      ? 'bg-[#22D3EE]/18 text-[#67E8F9] border border-[#22D3EE]/40'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  Text to Video
                </button>
                <button
                  type="button"
                  onClick={() => setVidMode('image')}
                  className={`h-8 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    vidMode === 'image'
                      ? 'bg-[#22D3EE]/18 text-[#67E8F9] border border-[#22D3EE]/40'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  Animate Photo
                </button>
              </div>

              {vidMode === 'image' && (
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Starting Frame Photo
                  </label>
                  {vidSourceImg ? (
                    <div className="bg-[#0B0D10] border border-[#22D3EE]/35 rounded-lg p-2 flex items-center gap-3">
                      <img
                        src={vidSourceImg.dataUrl}
                        alt={vidSourceImg.name}
                        className="w-14 h-14 object-cover rounded"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-[#F5F7FA] truncate">
                          {vidSourceImg.name}
                        </p>
                        <p className="text-[11px] text-[#67E8F9]">
                          {stagedVideoImage?.source === 'generated' &&
                          stagedVideoImage.dataUrl === vidSourceImg.dataUrl
                            ? 'Transferred from Image Studio · Ready to animate'
                            : 'Ready to animate'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setVidSourceImg(null);
                          onClearStagedVideoImage?.();
                        }}
                        className="p-1.5 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <label className="h-10 px-3.5 inline-flex items-center justify-center gap-2 w-full text-xs font-medium text-[#C7D0DF] bg-[#0B0D10] hover:bg-[#171C26] border border-dashed border-[#22D3EE]/30 rounded-lg cursor-pointer">
                      <Upload className="w-3.5 h-3.5 text-[#22D3EE]" />
                      Upload Photo to Animate
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => void handleVideoSourceUpload(e)}
                        className="sr-only"
                      />
                    </label>
                  )}
                </div>
              )}

              <div>
                <label
                  htmlFor="vid-prompt"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  {vidMode === 'image' ? 'Motion & Camera Direction' : 'Video Prompt'}
                </label>
                <textarea
                  id="vid-prompt"
                  rows={4}
                  value={vidPrompt}
                  onChange={(e) => setVidPrompt(e.target.value)}
                  placeholder="Describe subject movement, camera motion, lighting, and atmosphere..."
                  className="w-full p-3 bg-[#0B0D10] border border-[#22D3EE]/25 focus:border-[#22D3EE] rounded-lg text-sm text-[#F5F7FA] focus:outline-none resize-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Aspect
                  </label>
                  <select
                    value={vidAspect}
                    onChange={(e) => setVidAspect(e.target.value as '16:9' | '9:16')}
                    className="w-full h-10 px-2.5 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA]"
                  >
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Duration
                  </label>
                  <select
                    value={vidDuration}
                    onChange={(e) => setVidDuration(e.target.value as '4s' | '6s' | '8s')}
                    className="w-full h-10 px-2.5 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA]"
                  >
                    <option value="4s">4s</option>
                    <option value="6s">6s</option>
                    <option value="8s">8s</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                    Quality
                  </label>
                  <select
                    value={vidResolution}
                    onChange={(e) => setVidResolution(e.target.value as '720p' | '1080p')}
                    className="w-full h-10 px-2.5 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA]"
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </div>
              </div>

              {vidError && (
                <div className="p-3 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
                  {vidError}
                </div>
              )}

              <button
                type="submit"
                disabled={isGeneratingVideo || !vidPrompt.trim()}
                className="h-11 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 text-[#071318] font-semibold text-sm rounded-lg transition-colors cursor-pointer"
              >
                {isGeneratingVideo ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Rendering Video (may take 30–90s)...
                  </>
                ) : (
                  <>
                    <Film className="w-4 h-4" />
                    {vidMode === 'image' ? 'Animate Photo' : 'Generate Video'}
                  </>
                )}
              </button>
            </form>

            <div className="lg:col-span-7 flex flex-col gap-5">
              <div className="bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-[#F5F7FA]">Video Monitor</h3>
                  {generatedVideoUrl && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {onSendVideoTo3DStage && (
                        <button
                          type="button"
                          onClick={() =>
                            onSendVideoTo3DStage(
                              generatedVideoUrl,
                              generatedVideoMeta?.prompt?.slice(0, 56) || 'Media Lab Video Plate',
                              generatedVideoMeta?.aspectRatio
                            )
                          }
                          className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#0B0D10] border border-[#22D3EE]/50 hover:border-[#22D3EE] rounded-md whitespace-nowrap cursor-pointer"
                        >
                          <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                          Wrap Video on 3D Stage
                        </button>
                      )}
                      <a
                        href={generatedVideoUrl}
                        download={`dispatch-video-${Date.now()}.mp4`}
                        className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download MP4
                      </a>
                    </div>
                  )}
                </div>

                {generatedVideoUrl ? (
                  <div className="space-y-3">
                    <div className="bg-[#0B0D10] rounded-lg overflow-hidden border border-white/10 flex items-center justify-center">
                      <video
                        key={generatedVideoUrl}
                        src={generatedVideoUrl}
                        controls
                        autoPlay
                        loop
                        className="max-h-[460px] w-auto"
                      />
                    </div>
                    {generatedVideoMeta && (
                      <div className="flex items-center justify-between text-xs text-[#8C96A8]">
                        <span className="truncate max-w-[78%]">{generatedVideoMeta.prompt}</span>
                        <span className="font-mono tabular-nums text-[#67E8F9]">
                          {generatedVideoMeta.aspectRatio} · {generatedVideoMeta.duration}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-[340px] bg-[#0B0D10] border border-dashed border-white/10 rounded-lg flex flex-col items-center justify-center text-center px-6">
                    <Film className="w-7 h-7 text-[#22D3EE]/70 mb-3" />
                    <p className="text-sm text-[#C7D0DF] font-medium mb-1">
                      16:9 Landscape &amp; 9:16 Vertical Video
                    </p>
                    <p className="text-xs text-[#8C96A8] max-w-sm">
                      Generate motion B-roll from a text prompt or animate any uploaded still
                      photograph into video.
                    </p>
                  </div>
                )}
              </div>

              {filteredHistory.length > 0 && (
                <div className="bg-[#101319] border border-white/10 rounded-xl p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[#8C96A8] mb-3">
                    Recent Video Prompts
                  </h4>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {filteredHistory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setVidPrompt(item.prompt)}
                        className="w-full text-left p-2.5 bg-[#13161C] hover:bg-[#191E28] border border-white/10 rounded-lg text-xs text-[#C7D0DF] flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <span className="truncate">{item.prompt}</span>
                        <span className="text-[11px] text-[#8C96A8] shrink-0">
                          {item.previewNote || item.aspectRatio}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ---------- MUSIC TAB ---------- */}
        {subTab === 'music' && (
          <>
            <form
              onSubmit={(e) => void handleRunMusicStudio(e)}
              className="lg:col-span-5 bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4"
            >
              <div>
                <p className="text-[11px] uppercase tracking-wider text-[#22D3EE] font-medium mb-1">
                  Lyria 3 Audio Generation
                </p>
                <h2 className="font-serif text-2xl text-[#F5F7FA]">Music Composer</h2>
                <p className="text-xs text-[#8C96A8] mt-1">
                  Compose original beds, stingers, and full vocal or instrumental tracks from
                  a prompt and optional visual mood reference.
                </p>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                  Track Length &amp; Model
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMusicModel('lyria-3-clip-preview')}
                    className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                      musicModel === 'lyria-3-clip-preview'
                        ? 'bg-[#22D3EE]/15 border-[#22D3EE]/50 text-[#F5F7FA]'
                        : 'bg-[#0B0D10] border-white/10 text-[#8C96A8]'
                    }`}
                  >
                    <div className="text-xs font-semibold">Lyria 3 Clip</div>
                    <div className="text-[11px] text-[#8C96A8]">30s fast bed</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMusicModel('lyria-3-pro-preview')}
                    className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                      musicModel === 'lyria-3-pro-preview'
                        ? 'bg-[#22D3EE]/15 border-[#22D3EE]/50 text-[#F5F7FA]'
                        : 'bg-[#0B0D10] border-white/10 text-[#8C96A8]'
                    }`}
                  >
                    <div className="text-xs font-semibold">Lyria 3 Pro</div>
                    <div className="text-[11px] text-[#8C96A8]">Full-length song</div>
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="music-prompt"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  Musical Direction
                </label>
                <textarea
                  id="music-prompt"
                  rows={4}
                  value={musicPrompt}
                  onChange={(e) => setMusicPrompt(e.target.value)}
                  placeholder="Describe genre, tempo, instruments, mood, or vocal style..."
                  className="w-full p-3 bg-[#0B0D10] border border-[#22D3EE]/25 focus:border-[#22D3EE] rounded-lg text-sm text-[#F5F7FA] focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5">
                  Optional Visual Mood Reference
                </label>
                {musicRefImg ? (
                  <div className="bg-[#0B0D10] border border-[#22D3EE]/35 rounded-lg p-2 flex items-center gap-3">
                    <img
                      src={musicRefImg.dataUrl}
                      alt={musicRefImg.name}
                      className="w-12 h-12 object-cover rounded"
                    />
                    <span className="text-xs text-[#F5F7FA] truncate flex-1">
                      {musicRefImg.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMusicRefImg(null)}
                      className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <label className="h-10 px-3.5 inline-flex items-center justify-center gap-2 w-full text-xs font-medium text-[#C7D0DF] bg-[#0B0D10] hover:bg-[#171C26] border border-dashed border-[#22D3EE]/30 rounded-lg cursor-pointer">
                    <Upload className="w-3.5 h-3.5 text-[#22D3EE]" />
                    Attach Mood Image (Optional)
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => void handleMusicImageUpload(e)}
                      className="sr-only"
                    />
                  </label>
                )}
              </div>

              {musicError && (
                <div className="p-3 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
                  {musicError}
                </div>
              )}

              <button
                type="submit"
                disabled={isGeneratingMusic || !musicPrompt.trim()}
                className="h-11 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 text-[#071318] font-semibold text-sm rounded-lg transition-colors cursor-pointer"
              >
                {isGeneratingMusic ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Composing Track...
                  </>
                ) : (
                  <>
                    <Music2 className="w-4 h-4" />
                    Generate Music
                  </>
                )}
              </button>
            </form>

            <div className="lg:col-span-7 flex flex-col gap-5">
              <div className="bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-[#F5F7FA]">Audio Deck</h3>
                    {generatedMusicModel && (
                      <p className="text-[11px] text-[#8C96A8]">{generatedMusicModel}</p>
                    )}
                  </div>
                  {generatedMusicUrl && (
                    <a
                      href={generatedMusicUrl}
                      download={`dispatch-track-${Date.now()}.wav`}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download WAV
                    </a>
                  )}
                </div>

                {generatedMusicUrl ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-lg">
                      <audio
                        key={generatedMusicUrl}
                        src={generatedMusicUrl}
                        controls
                        className="w-full"
                      />
                    </div>
                    {generatedLyrics && (
                      <div className="p-4 bg-[#0B0D10] border border-white/10 rounded-lg">
                        <h4 className="text-[11px] uppercase tracking-wider text-[#22D3EE] mb-2">
                          Generated Lyrics &amp; Structure
                        </h4>
                        <pre className="text-xs text-[#DCE3EE] whitespace-pre-wrap font-sans leading-relaxed max-h-56 overflow-y-auto">
                          {generatedLyrics}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-[300px] bg-[#0B0D10] border border-dashed border-white/10 rounded-lg flex flex-col items-center justify-center text-center px-6">
                    <Music2 className="w-7 h-7 text-[#22D3EE]/70 mb-3" />
                    <p className="text-sm text-[#C7D0DF] font-medium mb-1">
                      Original Broadcast &amp; Creative Soundtracks
                    </p>
                    <p className="text-xs text-[#8C96A8] max-w-sm">
                      Choose Lyria 3 Clip for a 30-second bed or Lyria 3 Pro for a full-length
                      arranged track.
                    </p>
                  </div>
                )}
              </div>

              {filteredHistory.length > 0 && (
                <div className="bg-[#101319] border border-white/10 rounded-xl p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[#8C96A8] mb-3">
                    Recent Music Prompts
                  </h4>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {filteredHistory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setMusicPrompt(item.prompt)}
                        className="w-full text-left p-2.5 bg-[#13161C] hover:bg-[#191E28] border border-white/10 rounded-lg text-xs text-[#C7D0DF] flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <span className="truncate">{item.prompt}</span>
                        <span className="text-[11px] text-[#8C96A8] shrink-0">
                          {item.previewNote || item.modelId}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
