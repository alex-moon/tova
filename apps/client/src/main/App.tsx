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
import ConnectorOAuthCallback from './components/ConnectorOAuthCallback';
import ConnectorsView from './components/ConnectorsView';

export interface ToolEvent {
  phase: 'call' | 'result';
  name: string;
  label: string;
  query?: string;
  status?: 'ok' | 'empty';
  resultCount?: number;
  domains?: string[];
}

// Client-side mirror of the server's tool-event reconcile; keep in sync.
// @see #196
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
  // Honesty-guard verdict; absent = unassessed.
  // @see #371
  honesty?: { flagged?: boolean | null; reason?: string | null; checkedAt?: string | null };
  // assetId persists server-side; assetFilename is display-only.
  // @see #34
  assetId?: string;
  assetFilename?: string;
}

interface Session {
  _id: string;
  title: string;
  // System-maintained scope summary; absent until the first server revision.
  // @see #359
  subtitle?: string | null;
}

export function isAdminRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');
}

// @see #95
export function isProfileRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/profile');
}

// `/files`: `/assets` would collide with Vite's static build directory.
// @see #197
export function isFilesRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/files');
}

// @see #254 #251
export function isTasksRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/tasks');
}

// OAuth consent landing: the provider redirect target.
// @see #327
export function isConnectorCallbackRoute() {
  return (
    typeof window !== 'undefined' && window.location.pathname.startsWith('/connectors/callback')
  );
}

// @see #331
export function isConnectorsRoute() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/connectors');
}

function App() {
  const { user, loading } = useAuth();
  const showAdminView = isAdminRoute();
  const showProfileView = isProfileRoute();
  const showFilesView = isFilesRoute();
  const showTasksView = isTasksRoute();
  const showConnectorCallback = isConnectorCallbackRoute();
  const showConnectorsView = isConnectorsRoute() && !showConnectorCallback;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  // Bumped when the composer creates a task, so the embedded card refetches.
  // @see #255
  const [taskRefreshSignal, setTaskRefreshSignal] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const streamingRef = useRef(false);
  // null = profile incognito default; true/false is a deliberate override.
  // @see #144
  const [incognitoChoice, setIncognitoChoice] = useState<boolean | null>(null);
  // Opens the newest session once per mount; never overrides user selection.
  // @see #96
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
    // Incognito-default users never open a saved chat by default.
    // @see #144
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
    setMessages((prev) => [
      ...prev,
      { _id: Date.now().toString(), role: 'user', content, assetId, assetFilename },
    ]);
    const streamId = `stream-${Date.now()}`;
    setMessages((prev) => [...prev, { _id: streamId, role: 'assistant', content: '' }]);
    // Stored chats keep their flag; a new chat uses the toggle or default.
    // @see #144
    const profileIncognito = Boolean(user?.incognitoByDefault ?? user?.zdr);
    const incognito = incognitoChoice ?? profileIncognito;
    // New incognito chats send a bounded recent-turn replay for context.
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
          // 503/403 errors surface the server's message verbatim.
          // @see #168
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
      // Persisted id adopted at done; post-done frames must target it.
      // @see #381
      let settledId: string | null = null;

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
            // Show the serving provider as soon as the router resolves it.
            // @see #117
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
            // A result replaces its call in place, not a second chip.
            // @see #33 #196
            const toolEvent = data as unknown as ToolEvent;
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId
                  ? { ...m, tools: reconcileToolEvents(m.tools ?? [], toolEvent) }
                  : m,
              ),
            );
          } else if (event === 'honesty') {
            // Retrying resets the bubble; post-done flags the settled message.
            // @see #371 #381
            const verdict = data as Message['honesty'] & { retrying?: boolean };
            if (verdict.retrying) {
              setMessages((prev) =>
                prev.map((m) =>
                  m._id === streamId
                    ? { ...m, content: '', tools: [], sources: [], sourceTitles: [] }
                    : m,
                ),
              );
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m._id === streamId || m._id === settledId ? { ...m, honesty: verdict } : m,
                ),
              );
            }
          } else if (event === 'done' && data.complete) {
            const saved = data.message as Message | undefined;
            const sourceTitles = data.sourceTitles as SourceTitle[] | undefined;
            if (saved?._id) settledId = saved._id;
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
                      honesty: saved.honesty,
                      // Adopt server-reconciled summaries to match a refresh.
                      // @see #196
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
      // A turn bumps the session's last-message time; refetch the sidebar.
      // @see #226
      fetchSessions();
    }
  };

  // Hand composer text to the background worker; the chat stays untouched.
  // @see #255
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

  // User-owned title: server marks the row 'user'-titled; UI renders from it.
  // @see #359
  const handleRenameSession = async (id: string, title: string) => {
    try {
      const res = await axios.patch(`/api/chat/sessions/${id}`, { title });
      setSessions((prev) => prev.map((s) => (s._id === id ? res.data : s)));
    } catch (err) {
      console.error('Error renaming session:', err);
      toast.error('Could not rename the chat');
    }
  };

  const activeSession = activeSessionId
    ? (sessions.find((s) => s._id === activeSessionId) ?? null)
    : null;

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

  if (showConnectorCallback) {
    return (
      <main className="h-dvh w-full">
        <Toaster position="bottom-center" richColors />
        <ConnectorOAuthCallback />
      </main>
    );
  }
  if (showConnectorsView) {
    return (
      <main className="relative h-dvh w-full overflow-hidden">
        <Toaster position="bottom-center" richColors />
        <BackToChatLink />
        <ConnectorsView />
      </main>
    );
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
            onRenameSession={handleRenameSession}
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
            sessionTitle={activeSession?.title ?? null}
            sessionSubtitle={activeSession?.subtitle ?? null}
            onRenameSession={(title) => {
              if (activeSessionId) void handleRenameSession(activeSessionId, title);
            }}
            incognito={incognitoChoice ?? Boolean(user?.incognitoByDefault ?? user?.zdr)}
            onToggleIncognito={setIncognitoChoice}
          />
        </>
      )}
    </main>
  );
}

export default App;
