import { useRef, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Toaster, toast } from 'sonner';
import { useAuth } from './hooks/useAuth';
import FeedbackService from './services/feedback';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import Login from './components/Login';
import AdminView from './components/AdminView';
import ProfileView from './components/ProfileView';
import AssetsView from './components/AssetsView';
import TasksView from './components/TasksView';
import BackToChatLink from './components/BackToChatLink';
import TaskService from './services/tasks';

export interface ToolEvent {
  phase: 'call' | 'result';
  name: string;
  label: string;
  query?: string;
  status?: 'ok' | 'empty';
  resultCount?: number;
  domains?: string[];
}

// Client-side mirror of the server reconcile (#196, D2): a result replaces the
// most recent still-open call of the same name, carrying its query forward, so
// the live chip flips spinner → check in place instead of stacking two chips.
// An unmatched result is appended standalone; a resolved entry is never a merge
// target, so a like-named second result becomes its own chip. Kept in sync with
// `reconcileToolEvent` in `apps/server/src/routes/chat.ts` (their tests pin both).
export const reconcileToolEvents = (list: ToolEvent[], ev: ToolEvent): ToolEvent[] => {
  if (ev.phase === 'result') {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const candidate = list[i];
      if (candidate.phase === 'call' && candidate.name === ev.name) {
        const next = [...list];
        next[i] = { ...ev, ...(candidate.query ? { query: candidate.query } : {}) };
        return next;
      }
    }
  }
  return [...list, ev];
};

export interface SourceTitle {
  url: string;
  title: string;
}

export interface Message {
  _id: string;
  role: 'user' | 'assistant';
  content: string;
  modelName?: string;
  provider?: string;
  isError?: boolean;
  feedback?: { value: 'up' | 'down' | string | null; updatedAt?: Date | string | null };
  sources?: string[];
  sourceTitles?: SourceTitle[];
  suggestions?: string[];
  tools?: ToolEvent[];
  // Attached asset reference (issue #34): id persisted server-side;
  // assetFilename is display-only on the optimistic message (the persisted
  // history chip is resolved from the file list when needed).
  assetId?: string;
  assetFilename?: string;
}

interface Session {
  _id: string;
  title: string;
}

export function isAdminRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');
}

// Profile has the same separate-URL view treatment as admin (issue #95);
// both helpers sit together for the deferred app-wide router ticket.
export function isProfileRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/profile');
}

// Issue #197: the files view gets its own URL alongside profile/admin. It is
// `/files`, not `/assets` — the latter collides with Vite's static build
// directory, which nginx serves ahead of the SPA fallback.
export function isFilesRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/files');
}

// Issue #254 (epic #251): the tasks view (list + read-only stream + queued
// steering composer) gets its own URL alongside /files, /profile, /admin.
export function isTasksRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/tasks');
}

function App() {
  const { user, loading } = useAuth();
  const showAdminView = isAdminRoute();
  const showProfileView = isProfileRoute();
  const showFilesView = isFilesRoute();
  const showTasksView = isTasksRoute();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  // #255: bumped when the composer creates a task, so the embedded card
  // refetches immediately (an empty card does not poll).
  const [taskRefreshSignal, setTaskRefreshSignal] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const streamingRef = useRef(false);
  // Per-chat incognito (#144): the composer toggle's state. `null` means "no
  // manual choice yet — follow the profile's 'incognito by default'";
  // true/false is a deliberate override for the chat being started.
  const [incognitoChoice, setIncognitoChoice] = useState<boolean | null>(null);
  // Startup-chat preference (issue #96): 'recent' re-opens the newest session
  // once per mount; the ref guard keeps later refetches (after send, delete)
  // from ever overriding a user-selected or new session.
  const startupSessionRef = useRef(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await axios.get('/api/chat/sessions');
      setSessions(res.data);
    } catch (err) {
      console.error('Error fetching sessions:', err);
    }
  }, []);

  const fetchMessages = useCallback(async (sessionId: string) => {
    if (streamingRef.current) return;
    try {
      const res = await axios.get(`/api/chat/sessions/${sessionId}`);
      if (!streamingRef.current) {
        setMessages(res.data.messages);
      }
    } catch (err) {
      console.error('Error fetching messages:', err);
    }
  }, []);

  useEffect(() => {
    if (user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchSessions();
    }
  }, [user, fetchSessions]);

  useEffect(() => {
    if (startupSessionRef.current || sessions.length === 0) return;
    startupSessionRef.current = true;
    // 'new' starts with a blank composer; 'recent' (the default when unset)
    // opens the newest session once sessions have loaded. Incognito-default
    // users (#144, stored as settings.zdr) never open a saved chat by
    // default — their turns are stateless.
    if (user?.zdr) return;
    if ((user?.startupChat ?? 'recent') === 'recent') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveSessionId(sessions[0]._id);
    }
  }, [sessions, user]);

  useEffect(() => {
    if (activeSessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchMessages(activeSessionId);
    } else {
      setMessages([]);
    }
  }, [activeSessionId, fetchMessages]);

  const handleSendMessage = async (content: string, assetId?: string, assetFilename?: string) => {
    setIsChatLoading(true);
    streamingRef.current = true;
    // Show the user message immediately
    setMessages((prev) => [
      ...prev,
      { _id: Date.now().toString(), role: 'user', content, assetId, assetFilename },
    ]);
    const streamId = `stream-${Date.now()}`;
    setMessages((prev) => [...prev, { _id: streamId, role: 'assistant', content: '' }]);
    // Per-chat incognito (#144): a stored chat's flag is fixed at creation
    // (the server decides off Session.incognito); a new chat uses the
    // composer toggle's explicit choice, else the profile default.
    const profileIncognito = Boolean(user?.incognitoByDefault ?? user?.zdr);
    const incognito = incognitoChoice ?? profileIncognito;
    // Existing chats continue by sessionId; new chats carry the toggle's
    // decision plus, when incognito, a bounded replay of recent turns so the
    // server-side conversation has context without anything being stored.
    const sessionIdPayload = activeSessionId;
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          content,
          ...(assetId ? { assetId } : {}),
          ...(sessionIdPayload
            ? { sessionId: sessionIdPayload }
            : {
                zdr: incognito,
                ...(incognito
                  ? {
                      history: messages
                        .filter(
                          (m) =>
                            (m.role === 'user' || m.role === 'assistant') &&
                            !m.isError &&
                            m.content &&
                            m._id !== streamId,
                        )
                        .slice(-20)
                        .map((m) => ({ role: m.role, content: m.content })),
                    }
                  : {}),
              }),
        }),
      });

      if (!res.ok || !res.body) {
        if (res.body) {
          const msg = (await res.json().catch(() => null)) as { message?: string } | null;
          // #168: 503 = every model is cooling off (the server's friendly
          // message is the primary text); 403 = the geo block. Both surface
          // verbatim, exactly like the SSE error event would.
          if ((res.status === 403 || res.status === 503) && msg?.message) {
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId ? { ...m, content: msg.message as string, isError: true } : m,
              ),
            );
          }
        }
        throw new Error(`Stream request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentSessionId = activeSessionId;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event: '));
          const dataLine = lines.find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(7).trim();
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          if (event === 'meta') {
            const newSessionId = data.sessionId as string;
            if (newSessionId && newSessionId !== currentSessionId) {
              currentSessionId = newSessionId;
              setActiveSessionId(newSessionId);
              fetchSessions();
            }
            // Provider visibility (#117): show which provider serves the turn
            // as soon as the router resolves, including mid-stream.
            const routing = data.routing as { provider?: string } | undefined;
            if (routing?.provider) {
              const prov = routing.provider;
              setMessages((prev) =>
                prev.map((m) => (m._id === streamId ? { ...m, provider: prov } : m)),
              );
            }
          } else if (event === 'delta') {
            const delta = (data.content as string) || '';
            setMessages((prev) =>
              prev.map((m) => (m._id === streamId ? { ...m, content: m.content + delta } : m)),
            );
          } else if (event === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId
                  ? {
                      ...m,
                      content:
                        (data.message as string) ||
                        'Something went wrong on our end. Please try again.',
                      isError: true,
                    }
                  : m,
              ),
            );
          } else if (event === 'tool') {
            // Tool feedback for the streaming chip (issue #33): reconciled in
            // order so a call's result replaces it in place (#196, D2) rather
            // than stacking a second chip and leaving the spinner stuck.
            const toolEvent = data as unknown as ToolEvent;
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId
                  ? { ...m, tools: reconcileToolEvents(m.tools ?? [], toolEvent) }
                  : m,
              ),
            );
          } else if (event === 'done' && data.complete) {
            const saved = data.message as Message | undefined;
            const sourceTitles = data.sourceTitles as SourceTitle[] | undefined;
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId && saved
                  ? {
                      ...m,
                      _id: saved._id || m._id,
                      content: saved.content,
                      modelName: saved.modelName,
                      provider: saved.provider,
                      feedback: saved.feedback,
                      sources: saved.sources,
                      sourceTitles: saved.sourceTitles ?? sourceTitles,
                      suggestions: saved.suggestions,
                      // #196 (D3): adopt the server-reconciled summaries so
                      // the settled turn matches what a refresh would load.
                      ...(saved.tools ? { tools: saved.tools } : {}),
                    }
                  : m,
              ),
            );
          }
        }
      }
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((prev) =>
        prev.map((m) =>
          m._id === streamId && m.content === ''
            ? { ...m, content: 'Something went wrong on our end. Please try again.', isError: true }
            : m,
        ),
      );
    } finally {
      streamingRef.current = false;
      setIsChatLoading(false);
      // #226: a turn bumps the session's last-message time, so refetch to let
      // the sidebar (and any "recent chat" ordering) reflect the new order.
      fetchSessions();
    }
  };

  // #255 (F7): hand the composer text to the background worker. The task is
  // created with this chat as its thin origin; the chat itself stays untouched
  // until the worker reports back via the completion drain on a later turn.
  const handleSendToWorker = async (content: string) => {
    if (!activeSessionId) return;
    try {
      await TaskService.create(content, { kind: 'chat', sessionId: activeSessionId });
      toast.success('Sent to the background worker');
      setTaskRefreshSignal((n) => n + 1);
    } catch (err) {
      console.error('Delegation error:', err);
      toast.error('Could not send that to the worker');
    }
  };

  const handleFeedback = async (messageId: string, value: 'up' | 'down' | null) => {
    try {
      if (value === null) {
        await FeedbackService.clear(messageId);
      } else {
        await FeedbackService.record(messageId, value);
      }
      setMessages((prev) =>
        prev.map((m) =>
          m._id === messageId ? { ...m, feedback: { value, updatedAt: new Date() } } : m,
        ),
      );
    } catch (err) {
      console.error('Error recording feedback:', err);
    }
  };

  const handleNewChat = () => {
    setActiveSessionId(null);
    setMessages([]);
    setSidebarOpen(false);
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await axios.delete(`/api/chat/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s._id !== sessionId));
      toast.success('Chat deleted');
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('Error deleting session:', err);
      setMessages((prev) => [
        ...prev,
        {
          _id: `system-${Date.now()}`,
          role: 'assistant',
          content: 'Something went wrong deleting this chat. Please try again.',
          isError: true,
        },
      ]);
    }
  };

  if (loading) {
    return (
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="animate-pulse text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <main className="relative flex h-dvh w-full overflow-hidden">
      <Toaster position="bottom-center" richColors />
      {showProfileView ? (
        <>
          <BackToChatLink />
          <ProfileView />
        </>
      ) : showFilesView ? (
        <AssetsView />
      ) : showTasksView ? (
        <TasksView />
      ) : showAdminView && user.role === 'admin' ? (
        <>
          <BackToChatLink />
          <AdminView />
        </>
      ) : (
        <>
          {user.role === 'admin' && (
            <a
              href="/admin"
              className="absolute right-4 top-4 z-10 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground edge-glow-subtle"
            >
              Admin
            </a>
          )}
          <Sidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            open={sidebarOpen}
            onSelectSession={(id) => {
              setActiveSessionId(id);
              setSidebarOpen(false);
            }}
            onNewChat={handleNewChat}
            onDeleteSession={handleDeleteSession}
            onClose={() => setSidebarOpen(false)}
          />
          <ChatWindow
            messages={messages}
            onSendMessage={handleSendMessage}
            onSendToWorker={handleSendToWorker}
            taskRefreshSignal={taskRefreshSignal}
            isLoading={isChatLoading}
            onOpenSidebar={() => setSidebarOpen(true)}
            onFeedback={handleFeedback}
            sessionId={activeSessionId}
            incognito={incognitoChoice ?? Boolean(user?.incognitoByDefault ?? user?.zdr)}
            onToggleIncognito={setIncognitoChoice}
          />
        </>
      )}
    </main>
  );
}

export default App;
