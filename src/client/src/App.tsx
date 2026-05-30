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
    try {
      const res = await axios.post('/api/chat', {
        sessionId: activeSessionId,
        content,
      });

      if (!activeSessionId) {
        setActiveSessionId(res.data.sessionId);
        fetchSessions();
      }

      setMessages((prev) => [
        ...prev,
        { _id: Date.now().toString(), role: 'user', content },
        res.data.message,
      ]);
    } catch (err) {
      console.error('Chat error:', err);
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
