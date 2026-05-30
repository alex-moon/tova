import React from 'react';
import { useAuth } from '../hooks/useAuth';

interface Session {
  _id: string;
  title: string;
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
}) => {
  const { logout } = useAuth();

  return (
    <nav className="sidebar">
      <div style={{ padding: '1rem' }}>
        <button
          className="btn btn-ghost"
          style={{ width: '100%', border: '1px solid var(--color-border)' }}
          onClick={onNewChat}
        >
          + New Chat
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 1rem' }}>
        <div
          style={{
            padding: '0.5rem 0',
            color: 'var(--color-text)',
            opacity: 0.7,
            fontSize: '0.8rem',
          }}
        >
          Previous Chats
        </div>
        {sessions.map((session) => (
          <button
            key={session._id}
            className="btn btn-ghost"
            style={{
              width: '100%',
              justifyContent: 'flex-start',
              textAlign: 'left',
              backgroundColor:
                activeSessionId === session._id ? 'var(--color-border)' : 'transparent',
              marginBottom: '0.25rem',
              fontSize: '0.9rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            onClick={() => onSelectSession(session._id)}
          >
            {session.title}
          </button>
        ))}
      </div>
      <div style={{ padding: '1rem', borderTop: '1px solid var(--color-border)' }}>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={logout}>
          Logout
        </button>
      </div>
    </nav>
  );
};

export default Sidebar;
