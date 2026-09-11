import { useRef, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from './hooks/useAuth';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import Login from './components/Login';
import AdminView from './components/AdminView';

export interface Message {
  _id: string;
  role: 'user' | 'assistant';
  content: string;
  modelName?: string;
  isError?: boolean;
}

interface Session {
  _id: string;
  title: string;
}

function App() {
  const { user, loading } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const streamingRef = useRef(false);

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
    if (activeSessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchMessages(activeSessionId);
    } else {
      setMessages([]);
    }
  }, [activeSessionId, fetchMessages]);

  const handleSendMessage = async (content: string) => {
    setIsChatLoading(true);
    streamingRef.current = true;
    // Show the user message immediately
    setMessages((prev) => [...prev, { _id: Date.now().toString(), role: 'user', content }]);
    const streamId = `stream-${Date.now()}`;
    setMessages((prev) => [...prev, { _id: streamId, role: 'assistant', content: '' }]);
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId: activeSessionId, content }),
      });

      if (!res.ok || !res.body) {
        if (res.body) {
          const msg = (await res.json().catch(() => null)) as { message?: string } | null;
          if (res.status === 403 && msg?.message) {
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
          } else if (event === 'done' && data.complete) {
            const saved = data.message as Message | undefined;
            setMessages((prev) =>
              prev.map((m) =>
                m._id === streamId && saved
                  ? {
                      ...m,
                      _id: saved._id || m._id,
                      content: saved.content,
                      modelName: saved.modelName,
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
    <main className="flex h-dvh w-full overflow-hidden">
      {showAdmin ? (
        <>
          <button onClick={() => setShowAdmin(false)}>Back to chat</button>
          <AdminView />
        </>
      ) : (
        <>
          {user.role === 'admin' && <button onClick={() => setShowAdmin(true)}>Admin</button>}
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
            isLoading={isChatLoading}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
          <ChatWindow
            messages={messages}
            onSendMessage={handleSendMessage}
            isLoading={isChatLoading}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        </>
      )}
    </main>
  );
}

export default App;
