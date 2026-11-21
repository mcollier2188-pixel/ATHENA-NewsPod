import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Loader2,
  Pause,
  RotateCcw,
  Send,
  Volume2,
} from 'lucide-react';
import type { AudioBriefing, ChatMessage, CitationRef, NewsArticle } from '../types';
import { CitationList, CitedText } from './CitedText';

interface EditorChatViewProps {
  messages: ChatMessage[];
  articles: NewsArticle[];
  briefing: AudioBriefing | null;
  isSending: boolean;
  chatError: string | null;
  speakingMessageId: string | null;
  playingMessageId: string | null;
  onSendMessage: (text: string) => Promise<void>;
  onClearChat: () => void;
  onSpeakMessage: (message: ChatMessage) => Promise<void>;
  onStopSpeakingMessage: () => void;
  onSelectCitation: (citation: CitationRef) => void;
}

const STARTER_PROMPTS = [
  'How do the active sources in my notebook connect together?',
  'What is the biggest risk or unresolved question across these sources?',
  'Give me three sharp talking points with citations for my morning meeting.',
  'Explain the technical details from my documents in plain English.',
];

export function EditorChatView({
  messages,
  articles,
  briefing,
  isSending,
  chatError,
  speakingMessageId,
  playingMessageId,
  onSendMessage,
  onClearChat,
  onSpeakMessage,
  onStopSpeakingMessage,
  onSelectCitation,
}: EditorChatViewProps) {
  const [draft, setDraft] = useState('');
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const selectedCount = articles.filter((a) => a.selected).length;

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isSending]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = draft.trim();
    if (!cleaned || isSending) return;
    setDraft('');
    await onSendMessage(cleaned);
  }

  return (
    <div className="max-w-[920px] mx-auto px-5 sm:px-8 py-8 sm:py-9">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-[#22D3EE]/35">
        <div>
          <p className="font-mono text-xs text-[#67E8F9] tabular-nums">
            Notebook Research Editor · {selectedCount}{' '}
            {selectedCount === 1 ? 'source' : 'sources'} selected
            {briefing ? ` · Active edition loaded` : ''}
          </p>
          <h1 className="mt-1.5 font-serif text-3xl font-medium text-[#F5F7FA]">
            Ask the Editor
          </h1>
          <p className="mt-1 text-sm text-[#A0AABB]">
            Ask grounded questions across your uploaded documents and news articles. Click any citation number to inspect the exact passage.
          </p>
        </div>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={onClearChat}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8C96A8] hover:text-[#67E8F9] self-start sm:self-end whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            New conversation
          </button>
        )}
      </div>

      {/* Chat Thread Container */}
      <section
        aria-label="Conversation with the research editor"
        className="mt-6 bg-[#13161C] border border-[#22D3EE]/35 rounded-lg flex flex-col min-h-[520px] max-h-[68vh]"
      >
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 ? (
            <div className="py-8 max-w-xl mx-auto">
              <p className="font-serif text-xl text-[#F5F7FA]">
                What would you like to unpack from your selected sources?
              </p>
              <p className="mt-2 text-sm text-[#A0AABB] leading-relaxed">
                Every reply cites specific source passages you can click to verify in the Source Inspector—and you can tap <strong className="font-medium text-[#F5F7FA]">Listen</strong> on any answer to hear it aloud.
              </p>

              <div className="mt-6 divide-y divide-[#222833] border-t border-b border-[#222833]">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={isSending}
                    onClick={() => onSendMessage(prompt)}
                    className="w-full py-3.5 text-left text-sm text-[#D5DCE6] hover:text-[#67E8F9] transition-colors flex items-center justify-between gap-4 cursor-pointer"
                  >
                    <span>{prompt}</span>
                    <Send className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === 'user';
              const isSpeakingThis = speakingMessageId === msg.id;
              const isPlayingThis = playingMessageId === msg.id;

              return (
                <div
                  key={msg.id}
                  className={`pb-6 border-b border-[#1E2430] last:border-b-0 last:pb-0 ${
                    isUser ? 'pl-0 sm:pl-12' : 'pr-0 sm:pr-6'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`font-mono font-medium ${
                          isUser ? 'text-[#A0AABB]' : 'text-[#22D3EE]'
                        }`}
                      >
                        {isUser ? 'You' : 'Managing Editor'}
                      </span>
                      <span aria-hidden="true" className="text-[#394457]">
                        ·
                      </span>
                      <span className="font-mono text-[#6E788A] tabular-nums">
                        {new Intl.DateTimeFormat('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        }).format(new Date(msg.timestamp))}
                      </span>
                    </div>

                    {!isUser && (
                      <button
                        type="button"
                        disabled={Boolean(speakingMessageId) && !isSpeakingThis}
                        onClick={() =>
                          isPlayingThis ? onStopSpeakingMessage() : onSpeakMessage(msg)
                        }
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        {isSpeakingThis ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" aria-hidden="true" />
                            Synthesizing...
                          </>
                        ) : isPlayingThis ? (
                          <>
                            <Pause className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                            Stop audio
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                            Listen
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <div
                    className={`text-[15px] leading-[1.75] whitespace-pre-wrap max-w-prose ${
                      isUser ? 'text-[#F5F7FA] font-medium' : 'text-[#E4E9F1]'
                    }`}
                  >
                    {isUser ? (
                      msg.text
                    ) : (
                      <CitedText
                        text={msg.text}
                        citations={msg.citations}
                        onSelectCitation={onSelectCitation}
                      />
                    )}
                  </div>

                  {!isUser && (
                    <CitationList
                      citations={msg.citations}
                      onSelectCitation={onSelectCitation}
                    />
                  )}
                </div>
              );
            })
          )}

          {isSending && (
            <div className="flex items-center gap-2.5 text-sm text-[#A0AABB]">
              <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" aria-hidden="true" />
              <span>Reviewing your selected sources...</span>
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>

        {/* Error strip */}
        {chatError && (
          <div className="px-6 py-2.5 bg-[#3B1219] border-t border-[#F87171]/40 text-xs text-[#FCA5A5]">
            {chatError}
          </div>
        )}

        {/* Message composer */}
        <form
          onSubmit={handleSubmit}
          className="p-4 border-t border-[#222833] bg-[#0E1116] rounded-b-lg flex items-center gap-3"
        >
          <label htmlFor="editor-chat-input" className="sr-only">
            Ask the editor a question
          </label>
          <input
            id="editor-chat-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={isSending}
            placeholder="Ask a question grounded in your documents and articles..."
            className="flex-1 min-w-0 h-11 px-3.5 text-sm text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
          />
          <button
            type="submit"
            disabled={isSending || !draft.trim()}
            className="h-11 px-5 inline-flex items-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
