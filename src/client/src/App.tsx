import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from './hooks/useAuth';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import Login from './components/Login';

interface Message {
  _id: string;
  role: 'user' | 'assistant';
  content: string;
  modelName?: string;
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

  const fetchSessions = useCallback(async () => {
    try {
      const res = await axios.get('/api/chat/sessions');
      setSessions(res.data);
    } catch (err) {
      console.error('Error fetching sessions:', err);
    }
  }, []);

  const fetchMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await axios.get(`/api/chat/sessions/${sessionId}`);
      setMessages(res.data.messages);
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
      setMessages((prev) => prev.filter((m) => m._id !== streamId || m.content !== ''));
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleNewChat = () => {
    setActiveSessionId(null);
    setMessages([]);
  };

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        Loading...
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <main>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onNewChat={handleNewChat}
      />
      <ChatWindow messages={messages} onSendMessage={handleSendMessage} isLoading={isChatLoading} />
    </main>
  );
}

export default App;
