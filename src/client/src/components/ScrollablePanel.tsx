import React from 'react';
import { cn } from '@/lib/utils';

interface ScrollablePanelProps {
  title: React.ReactNode;
  /** Close control or other actions pinned in the header next to the title. */
  headerAdornment?: React.ReactNode;
  panelTestId?: string;
  bodyTestId?: string;
  /**
   * Overrides the default capped modal-card styling; e.g. the admin page fills
   * its viewport slot instead of capping at 85dvh.
   */
  panelClassName?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

/**
 * Standard capped panel with a pinned header and one internal scroller
 * (issue #79): the body grows and scrolls rather than clipping, regardless of
 * viewport height.
 */
const ScrollablePanel: React.FC<ScrollablePanelProps> = ({
  title,
  headerAdornment,
  panelTestId,
  bodyTestId,
  panelClassName,
  bodyClassName,
  children,
}) => (
  <div
    data-testid={panelTestId}
    className={cn(
      'flex max-h-[85dvh] w-full flex-col rounded-xl border border-border bg-card p-6 shadow-lg',
      panelClassName,
    )}
  >
    <div className="mb-4 flex shrink-0 items-center justify-between">
      <h2 className="font-heading text-xl font-semibold">{title}</h2>
      {headerAdornment}
    </div>
    <div data-testid={bodyTestId} className={cn('flex-1 overflow-y-auto', bodyClassName)}>
      {children}
    </div>
  </div>
);

export default ScrollablePanel;
