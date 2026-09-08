import React from 'react';
import { LogOut, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';
import { cn } from '@/lib/utils';
import { useAuth } from '../hooks/useAuth';

interface Session {
  _id: string;
  title: string;
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  open: boolean;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onClose: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  open,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onClose,
}) => {
  const { logout } = useAuth();

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} />}
      <nav
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-border bg-sidebar transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full invisible md:visible',
        )}
      >
        <div className="flex h-(--header-height) shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="font-heading text-xl font-semibold">Tova</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close menu"
            onClick={onClose}
            className="size-9 md:hidden"
          >
            <X />
          </Button>
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
                  'min-w-0 flex-1 cursor-pointer truncate rounded-lg px-4 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary',
                  activeSessionId === session._id && 'bg-accent font-medium text-accent-foreground',
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
        <div className="flex items-center border-t border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button variant="ghost" className="flex-1" onClick={logout}>
            <LogOut />
            Logout
          </Button>
          <ThemeToggle />
        </div>
      </nav>
    </>
  );
};

export default Sidebar;
