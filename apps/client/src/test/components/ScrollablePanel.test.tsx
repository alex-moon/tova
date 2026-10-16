import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ScrollablePanel from '../../main/components/ScrollablePanel';

describe('ScrollablePanel', () => {
  it('pins the header and puts the body in the single scroller (issue #79)', () => {
    cleanup();
    render(
      <ScrollablePanel
        title="Admin"
        panelTestId="panel"
        bodyTestId="body"
        headerAdornment={<button>X</button>}
        panelClassName="max-w-md"
      >
        <p>content</p>
      </ScrollablePanel>,
    );

    const panel = screen.getByTestId('panel');
    expect(panel).toHaveClass('flex', 'flex-col', 'max-h-[85dvh]');
    expect(screen.getByText('Admin').closest('.shrink-0')).not.toBeNull();

    const body = screen.getByTestId('body');
    expect(body).toHaveClass('flex-1', 'overflow-y-auto');
    expect(panel).toContainElement(body);
    expect(body).toContainElement(screen.getByText('content'));
  });
});
