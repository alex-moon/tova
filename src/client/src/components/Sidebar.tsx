import React from 'react';
import { LogOut, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
  onDeleteSession: (id: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
}) => {
  const { logout } = useAuth();

  return (
    <nav className="flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-(--header-height) shrink-0 items-center justify-center border-b border-border">
        <h2 className="font-heading text-xl font-semibold">Tova</h2>
      </div>
      <div className="p-4">
        <Button variant="outline" className="w-full" onClick={onNewChat}>
          <Plus />
          New Chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4">
        <div className="py-2 text-sm text-muted-foreground">Previous Chats</div>
        {sessions.map((session) => (
          <div key={session._id} className="mb-1 flex items-center">
            <button
              className={cn(
                'min-w-0 flex-1 truncate rounded-lg px-4 py-2 text-left text-sm hover:bg-accent',
                activeSessionId === session._id && 'bg-accent',
              )}
              onClick={() => onSelectSession(session._id)}
            >
              {session.title}
            </button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete chat"
              aria-label={`Delete chat: ${session.title}`}
              onClick={() => onDeleteSession(session._id)}
              className="ml-1 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="border-t border-border p-4">
        <Button variant="ghost" className="w-full" onClick={logout}>
          <LogOut />
          Logout
        </Button>
      </div>
    </nav>
  );
};

export default Sidebar;
