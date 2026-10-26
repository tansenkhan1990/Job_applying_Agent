import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type { ChatSendResponse, ChatSession, ChatSessionResponse } from '../api/types';
import { Badge, Button, Card, ErrorNote, Spinner, Textarea, cn } from './ui';

interface ChatPanelProps {
  /** API base for this target, e.g. `/jobs/<id>` or `/phd/positions/<id>`. */
  targetPath: string;
  title?: string;
  subtitle?: string;
  suggestions: string[];
  /** When provided, each answer offers a button that hands the text to the letter editor. */
  onUseReply?: (reply: string) => void;
  useReplyLabel?: string;
  className?: string;
}

function MessageList({
  session,
  onUseReply,
  useReplyLabel,
}: {
  session: ChatSession;
  onUseReply?: (reply: string) => void;
  useReplyLabel?: string;
}) {
  return (
    <ul className="space-y-2.5">
      {session.messages.map((message, index) => {
        const assistant = message.role === 'assistant';
        return (
          <li
            key={`${message.createdAt ?? index}-${index}`}
            className={cn('flex', assistant ? 'justify-start' : 'justify-end')}
          >
            <div
              className={cn(
                'max-w-[92%] rounded-lg border px-3 py-2 text-xs leading-relaxed',
                assistant
                  ? 'border-slate-800 bg-slate-950/60 text-slate-200'
                  : 'border-indigo-500/40 bg-indigo-500/15 text-indigo-50',
              )}
            >
              <p className="whitespace-pre-line">{message.content}</p>
              {assistant ? (
                <>
                  {message.sources?.length ? (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                      Sources: {message.sources.join(' · ')}
                    </p>
                  ) : null}
                  {onUseReply ? (
                    <div className="mt-1.5 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onUseReply(message.content)}
                      >
                        {useReplyLabel ?? 'Use in letter editor'}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-vacancy assistant. Conversations are stored server-side per job/PhD position, so a
 * chat opened from another posting never receives this posting's history or description.
 */
export function ChatPanel({
  targetPath,
  title = 'Ask about this role',
  subtitle = 'Answers use this posting, your CVs and your existing letters. Facts, estimates and unknowns are distinguished.',
  suggestions,
  onUseReply,
  useReplyLabel,
  className,
}: ChatPanelProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const chat = useQuery<ChatSessionResponse>({
    queryKey: ['chat', targetPath],
    queryFn: () => api<ChatSessionResponse>(`${targetPath}/chat`),
    enabled: Boolean(targetPath),
  });

  const session = chat.data?.session ?? null;
  const messageCount = session?.messages.length ?? 0;

  useEffect(() => {
    setInput('');
    setOpen(false);
  }, [targetPath]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messageCount, chat.isFetching]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['chat', targetPath] });

  const send = useMutation({
    mutationFn: (content: string) =>
      api<ChatSendResponse>(`${targetPath}/chat/messages`, {
        method: 'POST',
        body: { content, sessionId: session?.id },
      }),
    onSuccess: () => {
      setInput('');
      void invalidate();
    },
  });

  const newConversation = useMutation({
    mutationFn: () => api<{ session: ChatSession }>(`${targetPath}/chat`, { method: 'POST' }),
    onSuccess: () => {
      send.reset();
      void invalidate();
    },
  });

  const clear = useMutation({
    mutationFn: () => api<{ deleted: number }>(`${targetPath}/chat`, { method: 'DELETE' }),
    onSuccess: () => {
      send.reset();
      void invalidate();
    },
  });

  const submit = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || send.isPending) return;
    send.mutate(trimmed);
  };

  const busy = send.isPending || chat.isLoading;
  const error = chat.error ?? send.error ?? newConversation.error ?? clear.error;

  return (
    <Card
      className={className}
      title={title}
      subtitle={subtitle}
      action={
        <>
          <Button
            size="sm"
            variant="ghost"
            className="xl:hidden"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Hide chat' : 'Open chat'}
          </Button>
          {session ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clear.mutate()}
              loading={clear.isPending}
            >
              Clear chat
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => newConversation.mutate()}
              loading={newConversation.isPending}
            >
              New conversation
            </Button>
          )}
        </>
      }
    >
      <div className={cn('space-y-3', !open && 'hidden xl:block')}>
        {error ? <ErrorNote message={errorMessage(error)} /> : null}

        <div
          ref={scrollRef}
          className="max-h-80 overflow-y-auto rounded-lg border border-slate-800/70 bg-slate-950/30 p-2.5"
          aria-live="polite"
        >
          {chat.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
              <Spinner className="h-3.5 w-3.5" /> Loading conversation…
            </div>
          ) : session && session.messages.length > 0 ? (
            <MessageList session={session} onUseReply={onUseReply} useReplyLabel={useReplyLabel} />
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                No messages yet. Ask a question or start with one of these:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submit(suggestion)}
                    disabled={busy}
                    className="rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-left text-[11px] text-slate-300 hover:border-indigo-500/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {send.isPending ? (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
              <Spinner className="h-3.5 w-3.5" /> Reading the posting and your documents…
            </div>
          ) : null}
        </div>

        <Textarea
          className="min-h-20"
          value={input}
          maxLength={4000}
          placeholder="e.g. Which required skills are missing from my CV?"
          aria-label="Chat message"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(input);
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">
            Follow-ups keep this conversation's context. Nothing is applied or sent.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => submit(input)}
            loading={send.isPending}
            disabled={!input.trim()}
          >
            Send
          </Button>
        </div>

        {session?.aiModel ? (
          <p className="text-[10px] text-slate-500">Model: {session.aiModel}</p>
        ) : null}
        {onUseReply ? (
          <p className="text-[10px] text-slate-500">
            <Badge tone="neutral">Tip</Badge> Answers are suggestions. Copy one into the letter
            editor and save it yourself if you want to keep it.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
