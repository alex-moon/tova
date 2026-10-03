import React from 'react';
import { Files, LogOut, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import AssetLibrary from './AssetLibrary';
import type { AssetSummary } from '@/services/assets';
import { cn } from '@/lib/utils';
import { useAuth } from '../hooks/useAuth';
import { useConfirmDelete } from '../hooks/useConfirmDelete';

const avatarInitial = (user: {
  name?: string;
  avatarUrl?: string;
  preferredName?: string;
  email: string;
}) => {
  const source = (user.preferredName ?? '').trim() || (user.name ?? '').trim() || user.email;
  return source.charAt(0).toUpperCase();
};

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
  // Files overlay state is owned by App (issue #51): picking an asset from
  // the library has to close the overlay and reach the composer, both of
  // which live above this component.
  showFiles: boolean;
  onToggleFiles: (open: boolean) => void;
  onPickAsset?: (asset: AssetSummary) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  open,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onClose,
  showFiles,
  onToggleFiles,
  onPickAsset,
}) => {
  const { user, logout } = useAuth();
  const { armedId, arm, onYes, onAlways, onNo } = useConfirmDelete('chat', onDeleteSession);

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} />}
      {showFiles && <AssetLibrary onClose={() => onToggleFiles(false)} onPickAsset={onPickAsset} />}
      <nav
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-border bg-sidebar panel-surface transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full invisible md:visible',
        )}
      >
        <div className="flex h-(--header-height) shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <img src="/tova-logo.png" alt="" className="size-7" />
            <h2 className="font-heading text-xl font-semibold">Tova</h2>
          </div>
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
          <Button variant="ghost" className="mt-1 w-full" onClick={() => onToggleFiles(true)}>
            <Files />
            Files
          </Button>
          {/* Issue #197: the full assets view (with previews) lives at /assets. */}
          <a
            href="/assets"
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            View all files
          </a>
        </div>
        <div className="flex-1 overflow-y-auto px-4">
          <div className="py-2 text-sm text-muted-foreground">Previous Chats</div>
          {sessions.map((session) =>
            armedId === session._id ? (
              <div
                key={session._id}
                data-testid={`confirm-delete-chat-${session._id}`}
                className="mb-1 flex items-center gap-1 rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <span className="min-w-0 flex-1 truncate">Sure? Irreversible.</span>
                <button
                  type="button"
                  data-testid="confirm-yes"
                  aria-label="Yes, delete chat"
                  autoFocus
                  onClick={onYes}
                  className="rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground"
                >
                  Yes
                </button>
                <button
                  type="button"
                  data-testid="confirm-always"
                  aria-label="Always delete without asking"
                  onClick={() => void onAlways()}
                  className="rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground"
                >
                  Always
                </button>
                <button
                  type="button"
                  data-testid="confirm-no"
                  aria-label="No, keep the chat"
                  onClick={onNo}
                  className="rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground"
                >
                  No
                </button>
              </div>
            ) : (
              <div key={session._id} className="mb-1 flex items-center">
                <button
                  className={cn(
                    'min-w-0 flex-1 cursor-pointer truncate rounded-lg px-4 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary',
                    activeSessionId === session._id &&
                      'bg-accent font-medium text-accent-foreground',
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
                  onClick={() => arm(session._id)}
                  className="ml-1 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
            ),
          )}
        </div>
        <div className="flex items-center border-t border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <a
            href="/profile"
            aria-label="Open profile"
            title={user?.preferredName ?? user?.name ?? user?.email}
            className="mr-1 flex shrink-0 items-center rounded-lg p-2 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                data-testid="avatar-img"
                className="size-7 rounded-full"
              />
            ) : (
              <span
                data-testid="avatar-fallback"
                className="flex size-7 items-center justify-center rounded-full bg-primary text-sm text-white"
              >
                {user ? avatarInitial(user) : ''}
              </span>
            )}
          </a>
          <Button variant="ghost" className="flex-1" onClick={logout}>
            <LogOut />
            Logout
          </Button>
        </div>
      </nav>
    </>
  );
};

export default Sidebar;
