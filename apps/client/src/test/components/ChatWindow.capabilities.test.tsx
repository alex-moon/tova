import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ChatWindow from '../../main/components/ChatWindow';
import type { Message } from '../../main/App';
import CapabilityService from '../../main/services/capabilities';

vi.mock('../../main/services/capabilities', () => ({
  default: { get: vi.fn() },
}));

const renderChat = () =>
  render(
    <ChatWindow
      messages={[] as Message[]}
      onSendMessage={vi.fn()}
      isLoading={false}
      onOpenSidebar={vi.fn()}
    />,
  );

describe('ChatWindow capabilities panel (#366)', () => {
  beforeEach(() => {
    vi.mocked(CapabilityService.get).mockReset();
  });
  afterEach(cleanup);

  it('fetches lazily and renders built-in and deferred groups on open', async () => {
    vi.mocked(CapabilityService.get).mockResolvedValueOnce({
      tools: [
        { name: 'web_search', label: 'Search the web', status: 'ready' },
        { name: 'calculate', label: 'Calculations', status: 'ready' },
        { name: 'web_search2', label: 'Unconfigured row', status: 'unconfigured' },
      ],
      connectors: [
        {
          name: 'github',
          tools: [{ name: 'github_create_issue', description: 'Create an issue' }],
        },
      ],
    });
    renderChat();
    expect(screen.queryByTestId('capabilities-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('capabilities-toggle'));
    await waitFor(() => expect(screen.getByTestId('capabilities-panel')).toBeTruthy());
    expect(screen.getByTestId('capability-web_search')).toBeTruthy();
    expect(screen.getByTestId('capability-connector-github')).toBeTruthy();
    expect(screen.getByText(/needs a tool search first/i)).toBeTruthy();
  });

  it('offers the connectors link when there are no connected tools', async () => {
    vi.mocked(CapabilityService.get).mockResolvedValueOnce({ tools: [], connectors: [] });
    renderChat();
    fireEvent.click(screen.getByTestId('capabilities-toggle'));
    await waitFor(() => expect(screen.getByTestId('capabilities-panel')).toBeTruthy());
    expect(screen.getByText(/connect a tool collection/i)).toBeTruthy();
  });

  it('shows a load-failure note instead of pretending no tools exist', async () => {
    vi.mocked(CapabilityService.get).mockRejectedValueOnce(new Error('down'));
    renderChat();
    fireEvent.click(screen.getByTestId('capabilities-toggle'));
    await waitFor(() => expect(screen.getByTestId('capabilities-error')).toBeTruthy());
  });
});
