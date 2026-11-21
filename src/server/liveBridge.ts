import type { Server as HttpServer } from 'node:http';
import { Modality, type GoogleGenAI, type LiveServerMessage } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';

const VALID_VOICES = new Set(['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']);

export function attachLiveVoiceServer(
  httpServer: HttpServer,
  getGeminiClient: () => GoogleGenAI
) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const reqUrl = request.url || '';
    if (!reqUrl.startsWith('/api/live')) {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (clientWs, request) => {
    const urlObj = new URL(request.url || '/api/live', 'http://localhost');
    const rawVoice = urlObj.searchParams.get('voice') || 'Zephyr';
    const voiceName = VALID_VOICES.has(rawVoice) ? rawVoice : 'Zephyr';
    const persona =
      urlObj.searchParams.get('persona')?.slice(0, 600) ||
      'You are Dispatch Live, a warm, sharp real-time creative producer and research partner. Keep spoken answers concise, natural, and conversational.';

    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let isClosing = false;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getGeminiClient();
      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: persona,
        },
        callbacks: {
          onopen: () => {
            sendToClient({ type: 'ready', model: 'gemini-3.8-live', voice: voiceName });
          },
          onmessage: (message: LiveServerMessage) => {
            const content = message.serverContent;
            if (!content) return;

            if (content.interrupted) {
              sendToClient({ type: 'interrupted' });
            }

            if (content.inputTranscription?.text) {
              sendToClient({
                type: 'inputTranscript',
                text: content.inputTranscription.text,
              });
            }

            if (content.outputTranscription?.text) {
              sendToClient({
                type: 'outputTranscript',
                text: content.outputTranscription.text,
              });
            }

            for (const part of content.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                sendToClient({
                  type: 'audio',
                  data: part.inlineData.data,
                });
              }
            }

            if (content.turnComplete) {
              sendToClient({ type: 'turnComplete' });
            }
          },
          onerror: (err: unknown) => {
            const message =
              err instanceof Error
                ? err.message
                : 'Live voice session encountered a connection error.';
            sendToClient({ type: 'error', message });
          },
          onclose: () => {
            if (!isClosing) {
              sendToClient({ type: 'closed' });
            }
          },
        },
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not connect to Gemini Live API right now.';
      sendToClient({ type: 'error', message });
      clientWs.close();
      return;
    }

    clientWs.on('message', (raw) => {
      if (!liveSession) return;
      try {
        const parsed = JSON.parse(raw.toString()) as {
          type?: string;
          audio?: string;
          text?: string;
        };
        if (parsed.audio) {
          liveSession.sendRealtimeInput({
            audio: {
              data: parsed.audio,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (parsed.text && parsed.text.trim()) {
          liveSession.sendRealtimeInput({
            text: parsed.text.trim(),
          });
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
      isClosing = true;
      try {
        liveSession?.close();
      } catch {
        // Already closed
      }
      liveSession = null;
    });
  });
}
