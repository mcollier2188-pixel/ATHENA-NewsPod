import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  AudioLines,
  BookOpen,
  Check,
  Copy,
  FileAudio,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  PhoneOff,
  Plus,
  Radio,
  Send,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  VOICE_OPTIONS,
  type AudioBriefing,
  type ChatMessage,
  type CitationRef,
  type NewsArticle,
  type VoiceName,
} from '../types';
import { useAuth } from '../contexts/AuthContext';
import {
  SUITE_CHAT_MODELS,
  clearDbChatThread,
  deleteDbTranscription,
  fetchDbChatMessages,
  fetchDbChatThreads,
  fetchDbTranscriptions,
  saveDbChatMessage,
  saveDbTranscription,
  sendSuiteChat,
  transcribeAudioClip,
  type DbChatThreadSummary,
  type DbTranscriptionRow,
  type SuiteChatModelId,
} from '../services/suiteApi';
import { EditorChatView } from './EditorChatView';

type AiDeskTab = 'chat' | 'live' | 'transcribe' | 'editor';

interface AiDeskViewProps {
  // Existing cited Newsroom editor props so classic Ask Editor stays intact inside AI Desk
  editorMessages: ChatMessage[];
  articles: NewsArticle[];
  briefing: AudioBriefing | null;
  isEditorSending: boolean;
  editorError: string | null;
  speakingMessageId: string | null;
  playingMessageId: string | null;
  onSendEditorMessage: (text: string) => Promise<void>;
  onClearEditorChat: () => void;
  onSpeakEditorMessage: (message: ChatMessage) => Promise<void>;
  onStopSpeakingEditorMessage: () => void;
  onSelectCitation: (citation: CitationRef) => void;
  onSendTranscriptToSources?: (title: string, transcriptText: string) => void;
}

interface DeskChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  modelId: string;
  createdAt: string;
}

interface LiveTranscriptLine {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
}

const PERSONA_PRESETS = [
  {
    id: 'Managing Editor',
    label: 'Managing Editor',
    instruction:
      'You are a sharp Managing Editor. Give concise, well-structured, high-signal answers with clear recommendations.',
  },
  {
    id: 'Creative Director',
    label: 'Creative Director',
    instruction:
      'You are an experienced Creative Director specializing in visual storytelling, brand identity, web design, and video concepts.',
  },
  {
    id: 'Technical Architect',
    label: 'Technical Architect',
    instruction:
      'You are a Principal Systems Architect. Break down complex technical questions with crisp trade-offs and actionable next steps.',
  },
  {
    id: 'Field Producer',
    label: 'Field Producer',
    instruction:
      'You are a Field Producer helping plan location logistics, interview angles, and broadcast rundowns.',
  },
];

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function downsampleTo16k(
  buffer: Float32Array,
  sourceSampleRate: number
): Int16Array {
  if (sourceSampleRate === 16000) {
    return floatTo16BitPCM(buffer);
  }
  const ratio = sourceSampleRate / 16000;
  const newLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += buffer[j];
      count++;
    }
    result[i] = count > 0 ? sum / count : buffer[Math.min(start, buffer.length - 1)];
  }
  return floatTo16BitPCM(result);
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64Pcm24kToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const floats = new Float32Array(new ArrayBuffer(int16.length * 4));
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768;
  }
  return floats;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error('Could not read audio data.'));
    reader.readAsDataURL(blob);
  });
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function AiDeskView({
  editorMessages,
  articles,
  briefing,
  isEditorSending,
  editorError,
  speakingMessageId,
  playingMessageId,
  onSendEditorMessage,
  onClearEditorChat,
  onSpeakEditorMessage,
  onStopSpeakingEditorMessage,
  onSelectCitation,
  onSendTranscriptToSources,
}: AiDeskViewProps) {
  const { user, getIdToken, signInWithGoogle } = useAuth();
  const [subTab, setSubTab] = useState<AiDeskTab>('chat');

  // ---------- 1. Multi-Model Chat State (Multi-Thread) ----------
  const [selectedModel, setSelectedModel] =
    useState<SuiteChatModelId>('gemini-3.1-flash-lite');
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>('Managing Editor');
  const [activeThreadId, setActiveThreadId] = useState<string>('default');
  const [threads, setThreads] = useState<DbChatThreadSummary[]>([]);
  const [threadsOpen, setThreadsOpen] = useState<boolean>(true);
  const [isLoadingThread, setIsLoadingThread] = useState<boolean>(false);
  const [deskMessages, setDeskMessages] = useState<DeskChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const [isDictatingToChat, setIsDictatingToChat] = useState(false);
  const [isTranscribingDictation, setIsTranscribingDictation] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const dictateRecorderRef = useRef<MediaRecorder | null>(null);
  const dictateChunksRef = useRef<Blob[]>([]);
  const localThreadMessagesRef = useRef<Record<string, DeskChatMessage[]>>({});

  // Load saved thread summaries when signed in
  useEffect(() => {
    if (!user) return;
    let active = true;
    getIdToken()
      .then((token) => (token ? fetchDbChatThreads(token) : []))
      .then((loadedThreads) => {
        if (!active) return;
        setThreads(loadedThreads);
      })
      .catch(() => {
        // Keep current thread list if fetch fails
      });
    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  // Load messages for the active thread (Cloud SQL when signed in, local cache for guests)
  useEffect(() => {
    if (!user) {
      setDeskMessages(localThreadMessagesRef.current[activeThreadId] || []);
      return;
    }
    let active = true;
    setIsLoadingThread(true);
    getIdToken()
      .then((token) => (token ? fetchDbChatMessages(token, activeThreadId) : []))
      .then((rows) => {
        if (!active) return;
        setDeskMessages(
          rows.map((r) => ({
            id: `db-${r.id}`,
            role: r.role === 'model' ? 'model' : 'user',
            text: r.content,
            modelId: r.modelId,
            createdAt: r.createdAt,
          }))
        );
      })
      .catch(() => {
        // Keep local chat session available if fetch fails
      })
      .finally(() => {
        if (active) setIsLoadingThread(false);
      });
    return () => {
      active = false;
    };
  }, [user, activeThreadId, getIdToken]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [deskMessages, isSendingChat]);

  const activePersona =
    PERSONA_PRESETS.find((p) => p.id === selectedPersonaId) || PERSONA_PRESETS[0];

  const upsertThreadPreview = useCallback(
    (
      threadId: string,
      titleCandidate: string,
      lastMessageText: string,
      modelId: string,
      messageCount: number
    ) => {
      const nowIso = new Date().toISOString();
      setThreads((prev) => {
        const existing = prev.find((t) => t.threadId === threadId);
        const nextEntry: DbChatThreadSummary = {
          threadId,
          title: existing?.title || titleCandidate.slice(0, 64),
          lastMessage: lastMessageText.slice(0, 96),
          modelId,
          messageCount,
          updatedAt: nowIso,
        };
        return [nextEntry, ...prev.filter((t) => t.threadId !== threadId)];
      });
    },
    []
  );

  const handleCreateNewThread = () => {
    if (isSendingChat) return;
    if (!user) {
      localThreadMessagesRef.current[activeThreadId] = deskMessages;
    }
    const newId = `thread-${Date.now()}`;
    setActiveThreadId(newId);
    setDeskMessages([]);
    setChatErr(null);
  };

  const handleSelectThread = (threadId: string) => {
    if (threadId === activeThreadId || isSendingChat) return;
    if (!user) {
      localThreadMessagesRef.current[activeThreadId] = deskMessages;
    }
    setActiveThreadId(threadId);
    setChatErr(null);
  };

  const handleDeleteThread = async (threadId: string) => {
    if (isSendingChat) return;
    delete localThreadMessagesRef.current[threadId];
    const remaining = threads.filter((t) => t.threadId !== threadId);
    setThreads(remaining);
    if (threadId === activeThreadId) {
      const fallbackId = remaining[0]?.threadId || 'default';
      setActiveThreadId(fallbackId);
      setDeskMessages(!user ? localThreadMessagesRef.current[fallbackId] || [] : []);
      setChatErr(null);
    }
    if (user) {
      const token = await getIdToken();
      if (token) {
        clearDbChatThread(token, threadId).catch(() => {});
      }
    }
  };

  const handleSendDeskChat = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = chatDraft.trim();
    if (!trimmed || isSendingChat) return;

    const targetThreadId = activeThreadId;
    setChatErr(null);
    const userMsg: DeskChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
      modelId: selectedModel,
      createdAt: new Date().toISOString(),
    };
    const nextHistory = [...deskMessages, userMsg];
    setDeskMessages(nextHistory);
    if (!user) {
      localThreadMessagesRef.current[targetThreadId] = nextHistory;
    }
    upsertThreadPreview(
      targetThreadId,
      trimmed,
      trimmed,
      selectedModel,
      nextHistory.length
    );
    setChatDraft('');
    setIsSendingChat(true);

    try {
      const token = user ? await getIdToken() : null;
      if (token) {
        saveDbChatMessage(token, {
          threadId: targetThreadId,
          role: 'user',
          modelId: selectedModel,
          persona: activePersona.label,
          content: trimmed,
        }).catch(() => {});
      }

      const result = await sendSuiteChat({
        model: selectedModel,
        systemInstruction: activePersona.instruction,
        messages: nextHistory.map((m) => ({ role: m.role, text: m.text })),
      });

      const modelMsg: DeskChatMessage = {
        id: `m-${Date.now()}`,
        role: 'model',
        text: result.reply,
        modelId: result.model,
        createdAt: new Date().toISOString(),
      };
      const withReply = [...nextHistory, modelMsg];
      setDeskMessages((prev) => [...prev, modelMsg]);
      if (!user) {
        localThreadMessagesRef.current[targetThreadId] = withReply;
      }
      upsertThreadPreview(
        targetThreadId,
        trimmed,
        result.reply,
        result.model,
        withReply.length
      );

      if (token) {
        saveDbChatMessage(token, {
          threadId: targetThreadId,
          role: 'model',
          modelId: result.model,
          persona: activePersona.label,
          content: result.reply,
        }).catch(() => {});
      }
    } catch (err) {
      setChatErr(err instanceof Error ? err.message : 'Chat request failed.');
    } finally {
      setIsSendingChat(false);
    }
  };

  const handleClearDeskChat = async () => {
    const targetThreadId = activeThreadId;
    setDeskMessages([]);
    setChatErr(null);
    delete localThreadMessagesRef.current[targetThreadId];
    setThreads((prev) => prev.filter((t) => t.threadId !== targetThreadId));
    if (user) {
      const token = await getIdToken();
      if (token) {
        clearDbChatThread(token, targetThreadId).catch(() => {});
      }
    }
  };

  const handleToggleChatDictation = async () => {
    if (isDictatingToChat) {
      dictateRecorderRef.current?.stop();
      setIsDictatingToChat(false);
      return;
    }
    setChatErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      dictateChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) dictateChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(dictateChunksRef.current, { type: mimeType });
        if (blob.size < 200) return;
        setIsTranscribingDictation(true);
        try {
          const base64 = await blobToBase64(blob);
          const { transcript } = await transcribeAudioClip({
            audioBase64: base64,
            mimeType: mimeType.split(';')[0],
          });
          setChatDraft((prev) => (prev ? `${prev} ${transcript}` : transcript));
        } catch (err) {
          setChatErr(
            err instanceof Error ? err.message : 'Voice dictation failed.'
          );
        } finally {
          setIsTranscribingDictation(false);
        }
      };
      dictateRecorderRef.current = recorder;
      recorder.start();
      setIsDictatingToChat(true);
    } catch {
      setChatErr('Microphone permission was denied or unavailable.');
    }
  };

  // ---------- 2. Real-Time Live Voice (gemini-3.8-live) ----------
  const [liveVoice, setLiveVoice] = useState<VoiceName>('Zephyr');
  const [livePersona, setLivePersona] = useState(
    'You are Dispatch Live, an energetic, concise creative partner. Respond naturally in 2-3 spoken sentences.'
  );
  const [liveState, setLiveState] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [liveMuted, setLiveMuted] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveTextInput, setLiveTextInput] = useState('');
  const [liveLevel, setLiveLevel] = useState(0);
  const [liveTranscripts, setLiveTranscripts] = useState<LiveTranscriptLine[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveMutedRef = useRef<boolean>(false);

  useEffect(() => {
    liveMutedRef.current = liveMuted;
  }, [liveMuted]);

  const stopPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current = [];
    if (playbackCtxRef.current) {
      nextStartTimeRef.current = playbackCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const disconnectLiveSession = useCallback(() => {
    stopPlaybackQueue();
    try {
      micProcessorRef.current?.disconnect();
    } catch {
      // Ignore
    }
    micProcessorRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setLiveLevel(0);
    setLiveState('idle');
  }, [stopPlaybackQueue]);

  useEffect(() => {
    return () => {
      disconnectLiveSession();
    };
  }, [disconnectLiveSession]);

  const appendLiveTranscript = useCallback((role: 'user' | 'model', chunk: string) => {
    if (!chunk) return;
    setLiveTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [
          ...prev.slice(0, -1),
          { ...last, text: `${last.text}${chunk}` },
        ];
      }
      return [
        ...prev,
        {
          id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role,
          text: chunk,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      ];
    });
  }, []);

  const connectLiveSession = async () => {
    if (liveState !== 'idle') return;
    setLiveError(null);
    setLiveState('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      const playbackCtx = new AudioContext({ sampleRate: 24000 });
      if (playbackCtx.state === 'suspended') {
        await playbackCtx.resume();
      }
      playbackCtxRef.current = playbackCtx;
      nextStartTimeRef.current = playbackCtx.currentTime;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        voice: liveVoice,
        persona: livePersona.trim(),
      });
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/live?${qs.toString()}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            data?: string;
            text?: string;
            message?: string;
          };
          if (msg.type === 'ready') {
            setLiveState('connected');
            // Start streaming 16kHz PCM microphone frames
            const micCtx = new AudioContext();
            micAudioCtxRef.current = micCtx;
            const source = micCtx.createMediaStreamSource(stream);
            const processor = micCtx.createScriptProcessor(4096, 1, 1);
            micProcessorRef.current = processor;

            processor.onaudioprocess = (ev) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const input = ev.inputBuffer.getChannelData(0);
              let rms = 0;
              for (let i = 0; i < input.length; i++) {
                rms += input[i] * input[i];
              }
              const level = Math.min(1, Math.sqrt(rms / input.length) * 6);
              setLiveLevel(liveMutedRef.current ? 0 : level);

              if (liveMutedRef.current) return;
              const pcm16 = downsampleTo16k(input, micCtx.sampleRate);
              ws.send(JSON.stringify({ audio: int16ToBase64(pcm16) }));
            };

            source.connect(processor);
            processor.connect(micCtx.destination);
          } else if (msg.type === 'audio' && msg.data && playbackCtxRef.current) {
            const ctx = playbackCtxRef.current;
            const float32 = base64Pcm24kToFloat32(msg.data);
            const audioBuf = ctx.createBuffer(1, float32.length, 24000);
            audioBuf.copyToChannel(float32, 0);

            const bufSource = ctx.createBufferSource();
            bufSource.buffer = audioBuf;
            bufSource.connect(ctx.destination);
            const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
            bufSource.start(startAt);
            nextStartTimeRef.current = startAt + audioBuf.duration;
            activeSourcesRef.current.push(bufSource);
            bufSource.onended = () => {
              activeSourcesRef.current = activeSourcesRef.current.filter(
                (s) => s !== bufSource
              );
            };
          } else if (msg.type === 'interrupted') {
            stopPlaybackQueue();
          } else if (msg.type === 'inputTranscript' && msg.text) {
            appendLiveTranscript('user', msg.text);
          } else if (msg.type === 'outputTranscript' && msg.text) {
            appendLiveTranscript('model', msg.text);
          } else if (msg.type === 'error') {
            setLiveError(msg.message || 'Live voice session error.');
          } else if (msg.type === 'closed') {
            disconnectLiveSession();
          }
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onerror = () => {
        setLiveError('Could not establish real-time voice WebSocket connection.');
        disconnectLiveSession();
      };

      ws.onclose = () => {
        disconnectLiveSession();
      };
    } catch (err) {
      setLiveError(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for real-time voice.'
      );
      disconnectLiveSession();
    }
  };

  const handleSendLiveText = (e: FormEvent) => {
    e.preventDefault();
    const text = liveTextInput.trim();
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ text }));
    appendLiveTranscript('user', text);
    setLiveTextInput('');
  };

  // ---------- 3. Audio Transcription (gemini-3.5-transcribe) ----------
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isTranscribingClip, setIsTranscribingClip] = useState(false);
  const [transcribeErr, setTranscribeErr] = useState<string | null>(null);
  const [latestTranscript, setLatestTranscript] = useState('');
  const [transcriptTitle, setTranscriptTitle] = useState('Field Voice Note');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedTranscriptions, setSavedTranscriptions] = useState<DbTranscriptionRow[]>([]);

  const clipRecorderRef = useRef<MediaRecorder | null>(null);
  const clipChunksRef = useRef<Blob[]>([]);
  const recordIntervalRef = useRef<number | null>(null);
  const recordSecondsRef = useRef<number>(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    getIdToken()
      .then((token) => (token ? fetchDbTranscriptions(token) : []))
      .then((rows) => {
        if (active) setSavedTranscriptions(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  useEffect(() => {
    return () => {
      if (recordIntervalRef.current) window.clearInterval(recordIntervalRef.current);
    };
  }, []);

  const runTranscription = async (
    blob: Blob,
    mimeType: string,
    title: string,
    durationSec: number
  ) => {
    setTranscribeErr(null);
    setIsTranscribingClip(true);
    try {
      const base64 = await blobToBase64(blob);
      const { transcript } = await transcribeAudioClip({
        audioBase64: base64,
        mimeType: mimeType.split(';')[0] || 'audio/webm',
      });
      setLatestTranscript(transcript);
      setTranscriptTitle(title);

      if (user) {
        const token = await getIdToken();
        if (token) {
          const saved = await saveDbTranscription(token, {
            title,
            transcriptText: transcript,
            durationSeconds: durationSec,
            mimeType: mimeType.split(';')[0] || 'audio/webm',
          });
          setSavedTranscriptions((prev) => [saved, ...prev]);
        }
      }
    } catch (err) {
      setTranscribeErr(
        err instanceof Error ? err.message : 'Transcription failed.'
      );
    } finally {
      setIsTranscribingClip(false);
    }
  };

  const handleToggleClipRecord = async () => {
    if (isRecordingClip) {
      clipRecorderRef.current?.stop();
      setIsRecordingClip(false);
      if (recordIntervalRef.current) {
        window.clearInterval(recordIntervalRef.current);
        recordIntervalRef.current = null;
      }
      return;
    }

    setTranscribeErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      clipChunksRef.current = [];
      recordSecondsRef.current = 0;
      setRecordSeconds(0);

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) clipChunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(clipChunksRef.current, { type: mimeType });
        if (blob.size >= 200) {
          void runTranscription(
            blob,
            mimeType,
            `Mic Recording · ${new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}`,
            recordSecondsRef.current
          );
        }
      };

      clipRecorderRef.current = recorder;
      recorder.start();
      setIsRecordingClip(true);
      recordIntervalRef.current = window.setInterval(() => {
        recordSecondsRef.current += 1;
        setRecordSeconds(recordSecondsRef.current);
      }, 1000);
    } catch {
      setTranscribeErr('Microphone access was blocked or unavailable.');
    }
  };

  const handleAudioFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setTranscribeErr('Please upload a supported audio file (MP3, WAV, M4A, OGG, or WebM).');
      return;
    }
    void runTranscription(file, file.type || 'audio/mpeg', file.name, 0);
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
  };

  const handleDeleteTranscript = async (id: number) => {
    setSavedTranscriptions((prev) => prev.filter((item) => item.id !== id));
    if (user) {
      const token = await getIdToken();
      if (token) {
        deleteDbTranscription(token, id).catch(() => {});
      }
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col">
      {/* Compact Workspace Sub-Navigation */}
      <div className="bg-[#0E1116] border-b border-[#22D3EE]/20 px-5 sm:px-7 py-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {(
            [
              { id: 'chat', label: 'Multi-Model Chat', icon: MessageSquare },
              { id: 'live', label: 'Live Voice', icon: Radio },
              { id: 'transcribe', label: 'Transcribe', icon: AudioLines },
              { id: 'editor', label: 'Cited Newsroom Editor', icon: BookOpen },
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

        {!user && subTab !== 'editor' && (
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="text-xs text-[#8C96A8] hover:text-[#67E8F9] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign in with Google to save history across sessions
          </button>
        )}
      </div>

      {/* Sub-Tab 1: Multi-Model Chat with Collapsible Thread Rail */}
      {subTab === 'chat' && (
        <div className="flex-1 max-w-6xl w-full mx-auto px-5 sm:px-7 py-6 flex flex-col lg:flex-row gap-5">
          {/* Collapsible Threads Rail */}
          {threadsOpen && (
            <aside className="lg:w-[240px] shrink-0 bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-3.5 flex flex-col gap-3 max-h-[72vh]">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-white/10">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8C96A8]">
                  Threads ({threads.length})
                </span>
                <button
                  type="button"
                  onClick={handleCreateNewThread}
                  className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                  New
                </button>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5">
                {threads.length === 0 ? (
                  <p className="text-xs text-[#6E788A] px-1 py-2 leading-relaxed">
                    Start a conversation to log a thread here. Switch or start new threads anytime.
                  </p>
                ) : (
                  threads.map((t) => {
                    const isActive = t.threadId === activeThreadId;
                    return (
                      <div
                        key={t.threadId}
                        className={`group rounded-lg border transition-colors flex items-start gap-1.5 p-2 ${
                          isActive
                            ? 'bg-[#171E2A] border-[#22D3EE]/45'
                            : 'bg-[#13161C] border-white/10 hover:border-[#22D3EE]/30'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectThread(t.threadId)}
                          className="min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <p
                            className={`text-xs font-medium truncate ${
                              isActive ? 'text-[#67E8F9]' : 'text-[#F5F7FA]'
                            }`}
                          >
                            {t.title || 'Untitled Thread'}
                          </p>
                          <p className="text-[11px] text-[#8C96A8] truncate mt-0.5">
                            {t.lastMessage}
                          </p>
                          <p className="text-[10px] font-mono text-[#6E788A] tabular-nums mt-1">
                            {t.messageCount} {t.messageCount === 1 ? 'msg' : 'msgs'}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteThread(t.threadId)}
                          aria-label={`Delete thread ${t.title}`}
                          title="Delete thread"
                          className="p-1 text-[#6E788A] hover:text-red-300 opacity-75 group-hover:opacity-100 shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          )}

          {/* Main Chat Column */}
          <div className="flex-1 min-w-0 flex flex-col gap-5">
            {/* Controls Strip */}
            <div className="bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-4 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
              <div className="md:col-span-5">
                <label
                  htmlFor="desk-model-select"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  Gemini Model
                </label>
                <select
                  id="desk-model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as SuiteChatModelId)}
                  className="w-full h-10 px-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-sm text-[#F5F7FA] focus:outline-none focus:border-[#22D3EE]"
                >
                  {SUITE_CHAT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.tier}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-4">
                <label
                  htmlFor="desk-persona-select"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  Desk Role
                </label>
                <select
                  id="desk-persona-select"
                  value={selectedPersonaId}
                  onChange={(e) => setSelectedPersonaId(e.target.value)}
                  className="w-full h-10 px-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-sm text-[#F5F7FA] focus:outline-none focus:border-[#22D3EE]"
                >
                  {PERSONA_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setThreadsOpen((v) => !v)}
                  title={threadsOpen ? 'Hide threads panel' : 'Show threads panel'}
                  className="h-10 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#67E8F9] bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md whitespace-nowrap cursor-pointer"
                >
                  {threadsOpen ? (
                    <PanelLeftClose className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <PanelLeftOpen className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  Threads
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearDeskChat()}
                  disabled={deskMessages.length === 0}
                  className="h-10 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-40 bg-[#0B0D10] border border-[#22D3EE]/20 rounded-md whitespace-nowrap cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Clear
                </button>
              </div>
            </div>

            {/* Conversation Stream */}
            <div className="flex-1 min-h-[380px] max-h-[58vh] overflow-y-auto bg-[#101319] border border-[#22D3EE]/15 rounded-xl p-5 space-y-4">
              {isLoadingThread ? (
                <div className="h-full min-h-[280px] flex items-center justify-center gap-2 text-xs text-[#8C96A8]">
                  <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
                  Loading thread...
                </div>
              ) : deskMessages.length === 0 ? (
              <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center max-w-lg mx-auto">
                <h2 className="font-serif text-2xl text-[#F5F7FA] mb-2">
                  Multi-Model Gemini Desk
                </h2>
                <p className="text-sm text-[#8C96A8] mb-5">
                  Switch between Gemini 4 Carbon for deep reasoning, Gemini 4 Neon for complex
                  interactive drafting, Gemini 4 Hydrogen for balanced work, or Gemini 3.1
                  Flash-Lite for instant responses.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full">
                  {[
                    'Draft a 3-act visual storyboard for a local architecture showcase.',
                    'Compare three monetization models for an independent regional newsletter.',
                    'Outline a location scouting checklist for a two-day documentary shoot.',
                    'Critique a landing page hero headline and suggest 5 sharper alternatives.',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => setChatDraft(prompt)}
                      className="text-left p-3 text-xs text-[#C7D0DF] bg-[#13161C] hover:bg-[#191E28] border border-[#22D3EE]/15 hover:border-[#22D3EE]/40 rounded-lg transition-colors cursor-pointer"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              deskMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[84%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-[#22D3EE]/15 border border-[#22D3EE]/35 text-[#F5F7FA]'
                        : 'bg-[#151A23] border border-white/10 text-[#E6ECF5]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4 mb-1.5 text-[11px] text-[#8C96A8]">
                      <span className="font-medium uppercase tracking-wider">
                        {msg.role === 'user' ? 'You' : msg.modelId}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyText(msg.id, msg.text)}
                        className="inline-flex items-center gap-1 hover:text-[#67E8F9] cursor-pointer"
                      >
                        {copiedId === msg.id ? (
                          <Check className="w-3 h-3 text-[#22D3EE]" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                    {msg.text}
                  </div>
                </div>
              ))
            )}
            {isSendingChat && (
              <div className="flex items-center gap-2 text-xs text-[#67E8F9]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating with {selectedModel}...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {chatErr && (
            <div className="px-4 py-2.5 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
              {chatErr}
            </div>
          )}

          {/* Composer */}
          <form onSubmit={(e) => void handleSendDeskChat(e)} className="flex items-end gap-2.5">
            <div className="flex-1 relative">
              <textarea
                rows={2}
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendDeskChat();
                  }
                }}
                placeholder={`Ask ${selectedModel} anything (Shift+Enter for newline)...`}
                className="w-full px-4 py-3 pr-12 bg-[#13161C] border border-[#22D3EE]/25 focus:border-[#22D3EE] rounded-xl text-sm text-[#F5F7FA] placeholder:text-[#6F7A8C] focus:outline-none resize-none"
              />
              <button
                type="button"
                onClick={() => void handleToggleChatDictation()}
                disabled={isTranscribingDictation}
                title={isDictatingToChat ? 'Stop dictation' : 'Dictate prompt with microphone'}
                className={`absolute right-2.5 bottom-2.5 w-8 h-8 rounded-md flex items-center justify-center transition-colors cursor-pointer ${
                  isDictatingToChat
                    ? 'bg-red-500/20 text-red-300 border border-red-400/50'
                    : 'bg-[#0B0D10] text-[#8C96A8] hover:text-[#67E8F9] border border-white/10'
                }`}
              >
                {isTranscribingDictation ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isDictatingToChat ? (
                  <Square className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>
            </div>
            <button
              type="submit"
              disabled={!chatDraft.trim() || isSendingChat}
              className="h-[68px] px-5 inline-flex items-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-40 text-[#071318] font-semibold text-sm rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          </form>
          </div>
        </div>
      )}

      {/* Sub-Tab 2: Live Voice (gemini-3.8-live) */}
      {subTab === 'live' && (
        <div className="flex-1 max-w-5xl w-full mx-auto px-5 sm:px-7 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-5">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-[#22D3EE] font-medium mb-1">
                Gemini 3.8 Live · Bidirectional Audio
              </p>
              <h2 className="font-serif text-2xl text-[#F5F7FA]">
                Real-Time Voice Studio
              </h2>
              <p className="text-xs text-[#8C96A8] mt-1 leading-relaxed">
                Speak naturally with low-latency voice turn-taking. Interrupt at any moment
                to redirect the conversation.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="live-voice-select"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  Voice
                </label>
                <select
                  id="live-voice-select"
                  disabled={liveState !== 'idle'}
                  value={liveVoice}
                  onChange={(e) => setLiveVoice(e.target.value as VoiceName)}
                  className="w-full h-10 px-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-sm text-[#F5F7FA] disabled:opacity-50"
                >
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} — {v.descriptor}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="live-persona-input"
                  className="block text-[11px] uppercase tracking-wider text-[#8C96A8] mb-1.5"
                >
                  Session Instructions
                </label>
                <textarea
                  id="live-persona-input"
                  rows={3}
                  disabled={liveState !== 'idle'}
                  value={livePersona}
                  onChange={(e) => setLivePersona(e.target.value)}
                  className="w-full p-3 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-md text-xs text-[#F5F7FA] disabled:opacity-50 resize-none"
                />
              </div>
            </div>

            {/* Audio Level Visualizer */}
            <div className="bg-[#0B0D10] border border-white/10 rounded-lg p-4">
              <div className="flex items-center justify-between text-xs text-[#8C96A8] mb-3">
                <span>
                  {liveState === 'connected'
                    ? liveMuted
                      ? 'Microphone muted'
                      : 'Listening · Speak naturally'
                    : liveState === 'connecting'
                      ? 'Connecting live audio...'
                      : 'Ready to connect'}
                </span>
                <span className="font-mono tabular-nums text-[#67E8F9]">
                  16 kHz in · 24 kHz out
                </span>
              </div>
              <div className="h-10 flex items-center gap-1.5">
                {Array.from({ length: 24 }).map((_, idx) => {
                  const waveFactor = Math.sin((idx / 23) * Math.PI);
                  const heightPct =
                    liveState === 'connected'
                      ? Math.max(14, Math.min(100, Math.round(liveLevel * 120 * waveFactor + 14)))
                      : 14;
                  return (
                    <div
                      key={idx}
                      className="flex-1 rounded-sm transition-all duration-75"
                      style={{
                        height: `${heightPct}%`,
                        backgroundColor:
                          liveState === 'connected' && !liveMuted
                            ? '#22D3EE'
                            : 'rgba(140, 150, 168, 0.25)',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {liveError && (
              <div className="p-3 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
                {liveError}
              </div>
            )}

            <div className="flex items-center gap-2.5 mt-auto">
              {liveState === 'idle' ? (
                <button
                  type="button"
                  onClick={() => void connectLiveSession()}
                  className="flex-1 h-11 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                >
                  <PhoneCall className="w-4 h-4" />
                  Start Live Voice
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setLiveMuted((prev) => !prev)}
                    className={`h-11 px-4 inline-flex items-center justify-center gap-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                      liveMuted
                        ? 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                        : 'bg-[#0B0D10] border-[#22D3EE]/30 text-[#F5F7FA]'
                    }`}
                  >
                    {liveMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    {liveMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    onClick={disconnectLiveSession}
                    className="flex-1 h-11 px-4 inline-flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 border border-red-400/45 text-red-100 font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                  >
                    <PhoneOff className="w-4 h-4" />
                    End Session
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Live Transcript Pane */}
          <div className="lg:col-span-7 bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col min-h-[440px]">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
              <h3 className="text-sm font-semibold text-[#F5F7FA]">Live Transcript</h3>
              <button
                type="button"
                onClick={() => setLiveTranscripts([])}
                disabled={liveTranscripts.length === 0}
                className="text-xs text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-40 cursor-pointer"
              >
                Clear transcript
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[420px]">
              {liveTranscripts.length === 0 ? (
                <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center px-6">
                  <p className="text-sm text-[#C7D0DF] font-medium mb-1">
                    No spoken turns yet
                  </p>
                  <p className="text-xs text-[#8C96A8] max-w-sm">
                    Press Start Live Voice to talk directly with Gemini 3.8 Live. Both your
                    speech and Gemini&apos;s spoken replies appear here in real time.
                  </p>
                </div>
              ) : (
                liveTranscripts.map((line) => (
                  <div
                    key={line.id}
                    className={`p-3 rounded-lg text-sm ${
                      line.role === 'user'
                        ? 'bg-[#22D3EE]/12 border border-[#22D3EE]/30 text-[#F5F7FA]'
                        : 'bg-[#151A23] border border-white/10 text-[#DCE3EE]'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px] text-[#8C96A8] mb-1">
                      <span className="uppercase tracking-wider font-medium">
                        {line.role === 'user' ? 'You' : `Gemini Live (${liveVoice})`}
                      </span>
                      <span className="tabular-nums">{line.timestamp}</span>
                    </div>
                    <p className="leading-relaxed">{line.text}</p>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSendLiveText} className="mt-4 flex items-center gap-2">
              <input
                type="text"
                value={liveTextInput}
                onChange={(e) => setLiveTextInput(e.target.value)}
                disabled={liveState !== 'connected'}
                placeholder="Optional: send a text prompt into the live voice session..."
                className="flex-1 h-10 px-3.5 bg-[#0B0D10] border border-[#22D3EE]/25 rounded-lg text-xs text-[#F5F7FA] placeholder:text-[#6F7A8C] disabled:opacity-45 focus:outline-none focus:border-[#22D3EE]"
              />
              <button
                type="submit"
                disabled={liveState !== 'connected' || !liveTextInput.trim()}
                className="h-10 px-4 bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-40 text-[#071318] font-semibold text-xs rounded-lg whitespace-nowrap cursor-pointer"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Sub-Tab 3: Audio Transcription (gemini-3.5-transcribe) */}
      {subTab === 'transcribe' && (
        <div className="flex-1 max-w-5xl w-full mx-auto px-5 sm:px-7 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 bg-[#13161C] border border-[#22D3EE]/20 rounded-xl p-5 flex flex-col gap-5">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-[#22D3EE] font-medium mb-1">
                Gemini 3.5 Transcribe
              </p>
              <h2 className="font-serif text-2xl text-[#F5F7FA]">
                Speech-to-Text Desk
              </h2>
              <p className="text-xs text-[#8C96A8] mt-1 leading-relaxed">
                Record directly from your microphone or upload an interview clip to produce
                clean, punctuated transcripts.
              </p>
            </div>

            <div className="bg-[#0B0D10] border border-white/10 rounded-xl p-5 flex flex-col items-center text-center gap-4">
              <div className="font-mono text-3xl font-semibold tabular-nums text-[#F5F7FA]">
                {formatTimer(recordSeconds)}
              </div>
              <button
                type="button"
                disabled={isTranscribingClip}
                onClick={() => void handleToggleClipRecord()}
                className={`w-full h-11 px-4 inline-flex items-center justify-center gap-2 font-semibold text-sm rounded-lg transition-colors cursor-pointer ${
                  isRecordingClip
                    ? 'bg-red-500/25 border border-red-400/50 text-red-100 hover:bg-red-500/35'
                    : 'bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318]'
                }`}
              >
                {isRecordingClip ? (
                  <>
                    <Square className="w-4 h-4 fill-current" />
                    Stop &amp; Transcribe
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4" />
                    Record Microphone
                  </>
                )}
              </button>

              <div className="w-full border-t border-white/10 pt-4">
                <label className="w-full h-10 px-4 inline-flex items-center justify-center gap-2 text-xs font-medium text-[#C7D0DF] bg-[#13161C] hover:bg-[#191E28] border border-[#22D3EE]/25 rounded-lg cursor-pointer transition-colors">
                  <Upload className="w-3.5 h-3.5 text-[#22D3EE]" />
                  Upload Audio File (MP3, WAV, M4A, WebM)
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={handleAudioFileUpload}
                    disabled={isTranscribingClip || isRecordingClip}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            {isTranscribingClip && (
              <div className="flex items-center gap-2 text-xs text-[#67E8F9]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Transcribing audio with Gemini 3.5 Transcribe...
              </div>
            )}

            {transcribeErr && (
              <div className="p-3 bg-red-950/50 border border-red-400/35 rounded-lg text-xs text-red-200">
                {transcribeErr}
              </div>
            )}
          </div>

          <div className="lg:col-span-7 flex flex-col gap-5">
            {/* Active Transcript Result */}
            <div className="bg-[#101319] border border-[#22D3EE]/20 rounded-xl p-5">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#F5F7FA]">
                    {latestTranscript ? transcriptTitle : 'Latest Transcript'}
                  </h3>
                </div>
                {latestTranscript && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => handleCopyText('latest', latestTranscript)}
                      className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs text-[#C7D0DF] bg-[#13161C] border border-white/10 rounded-md hover:border-[#22D3EE]/40 cursor-pointer"
                    >
                      {copiedId === 'latest' ? (
                        <Check className="w-3.5 h-3.5 text-[#22D3EE]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      Copy
                    </button>
                    {onSendTranscriptToSources && (
                      <button
                        type="button"
                        onClick={() =>
                          onSendTranscriptToSources(transcriptTitle, latestTranscript)
                        }
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#13161C] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        Send to Sources
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setChatDraft(
                          `Summarize and extract key action items from this transcript:\n\n${latestTranscript}`
                        );
                        setSubTab('chat');
                      }}
                      className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md cursor-pointer"
                    >
                      Send to Chat
                    </button>
                  </div>
                )}
              </div>

              {latestTranscript ? (
                <div className="p-4 bg-[#0B0D10] border border-white/10 rounded-lg text-sm text-[#E6ECF5] leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {latestTranscript}
                </div>
              ) : (
                <div className="p-8 bg-[#0B0D10] border border-dashed border-white/10 rounded-lg text-center text-xs text-[#8C96A8]">
                  Record a voice note or upload an audio file to inspect the transcript here.
                </div>
              )}
            </div>

            {/* Saved Cloud Transcripts */}
            <div className="bg-[#101319] border border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-[#F5F7FA] inline-flex items-center gap-2">
                  <FileAudio className="w-4 h-4 text-[#22D3EE]" />
                  Saved Transcripts
                </h3>
                <span className="text-xs text-[#8C96A8] tabular-nums">
                  {savedTranscriptions.length} saved
                </span>
              </div>

              {savedTranscriptions.length === 0 ? (
                <p className="text-xs text-[#8C96A8]">
                  {user
                    ? 'Your recorded and uploaded transcripts will appear here automatically.'
                    : 'Sign in with Google to archive your transcriptions across sessions.'}
                </p>
              ) : (
                <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                  {savedTranscriptions.map((item) => (
                    <div
                      key={item.id}
                      className="p-3 bg-[#13161C] border border-white/10 rounded-lg"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-xs font-medium text-[#F5F7FA] truncate">
                          {item.title}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {item.durationSeconds > 0 && (
                            <span className="text-[11px] font-mono tabular-nums text-[#8C96A8]">
                              {formatTimer(item.durationSeconds)}
                            </span>
                          )}
                          {onSendTranscriptToSources && (
                            <button
                              type="button"
                              onClick={() =>
                                onSendTranscriptToSources(item.title, item.transcriptText)
                              }
                              className="h-6 px-2 inline-flex items-center gap-1 text-[11px] text-[#67E8F9] bg-[#0B0D10] border border-[#22D3EE]/35 hover:border-[#22D3EE] rounded cursor-pointer"
                              title="Index this transcript into Newsroom Sources"
                            >
                              <BookOpen className="w-3 h-3" />
                              To Sources
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopyText(`t-${item.id}`, item.transcriptText)}
                            className="text-[#8C96A8] hover:text-[#67E8F9] cursor-pointer"
                            title="Copy transcript"
                          >
                            {copiedId === `t-${item.id}` ? (
                              <Check className="w-3.5 h-3.5 text-[#22D3EE]" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteTranscript(item.id)}
                            className="text-[#8C96A8] hover:text-red-300 cursor-pointer"
                            title="Delete transcript"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-[#B7C2D4] line-clamp-3 leading-relaxed">
                        {item.transcriptText}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 4: Classic Source-Grounded Cited Editor */}
      {subTab === 'editor' && (
        <EditorChatView
          messages={editorMessages}
          articles={articles}
          briefing={briefing}
          isSending={isEditorSending}
          chatError={editorError}
          speakingMessageId={speakingMessageId}
          playingMessageId={playingMessageId}
          onSendMessage={onSendEditorMessage}
          onClearChat={onClearEditorChat}
          onSpeakMessage={onSpeakEditorMessage}
          onStopSpeakingMessage={onStopSpeakingEditorMessage}
          onSelectCitation={onSelectCitation}
        />
      )}
    </div>
  );
}
