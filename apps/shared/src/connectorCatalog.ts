// Curated connector catalog (#331, epic #328; ranking per #326's market-share
// research). The single source the client grid reads; server validation joins
// it when it needs to (#330). Entries carry everything the UI needs to render
// a card and drive the connect modal without a network round-trip.
import type { ConnectorDefinition } from './connectors';

export type ConnectorCatalogState = 'live' | 'watchlisted';

// The UI-facing definition: catalog state rides alongside the base shape.
export type CatalogEntry = ConnectorDefinition & {
  state: ConnectorCatalogState;
  // Watchlisted entries must say why, in honest copy.
  watchlistNote?: string;
  // Brand color for the letter-tile logo fallback (brands without a
  // licensed simple-icons mark, e.g. Slack).
  brandColor?: string;
};

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    authType: 'mcp.oauth',
    endpoint: 'https://drivemcp.googleapis.com/mcp/v1',
    summary: 'Search and read your Drive files.',
    state: 'watchlisted',
    watchlistNote:
      'Google only grants access through its Developer Preview enrollment with a custom OAuth client — not connectable until that opens up.',
    brandColor: '#4285F4',
    iconRef: 'googledrive',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    authType: 'mcp.oauth',
    endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
    summary: 'Search and draft email (drafts only — no sending).',
    state: 'watchlisted',
    watchlistNote:
      'Same Google Developer Preview gating as Drive, and the server drafts only (no send). Re-check when the preview opens.',
    brandColor: '#EA4335',
    iconRef: 'gmail',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    authType: 'mcp.oauth',
    endpoint: 'https://calendarmcp.googleapis.com/mcp/v1',
    summary: 'Read and manage your calendar.',
    state: 'watchlisted',
    watchlistNote: 'Google Developer Preview gating — same as Drive and Gmail.',
    brandColor: '#4285F4',
    iconRef: 'googlecalendar',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    authType: 'mcp.oauth',
    endpoint: 'https://mapsmcp.googleapis.com/mcp/v1',
    summary: 'Places and directions lookups.',
    state: 'watchlisted',
    watchlistNote:
      'Developer Preview gating, plus the endpoint still needs Google-side verification. Re-check with the other Google entries.',
    brandColor: '#4285F4',
    iconRef: 'googlemaps',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp-gateway-external-pilot.spotify.net/mcp',
    summary: 'Control playback and browse your library.',
    state: 'watchlisted',
    watchlistNote:
      'Official but a "pilot" endpoint that may move — held back until it proves stable (#330 watchlist).',
    brandColor: '#1ED760',
    iconRef: 'spotify',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp.dropbox.com/mcp',
    summary: 'Browse, read, and search your Dropbox files.',
    state: 'live',
    brandColor: '#0061FF',
    iconRef: 'dropbox',
  },
  {
    id: 'notion',
    name: 'Notion',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp.notion.com/mcp',
    summary: 'Search, read, and edit your Notion pages.',
    state: 'live',
    brandColor: '#000000',
    iconRef: 'notion',
  },
  {
    id: 'slack',
    name: 'Slack',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp.slack.com/mcp',
    summary: 'Read channels and send messages.',
    state: 'live',
    brandColor: '#611F69',
    iconRef: undefined, // removed from simple-icons (trademark request); letter tile
  },
  {
    id: 'trello',
    name: 'Trello',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp.trello.com/v1',
    summary: 'Manage boards, lists, and cards.',
    state: 'live',
    brandColor: '#0052CC',
    iconRef: 'trello',
  },
  {
    id: 'linear',
    name: 'Linear',
    authType: 'mcp.oauth',
    endpoint: 'https://mcp.linear.app/mcp',
    summary: 'Work with issues, projects, and cycles.',
    state: 'live',
    brandColor: '#5E6AD2',
    iconRef: 'linear',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    authType: 'mcp.pat',
    endpoint: 'https://mcp.atlassian.com/v1',
    summary: 'Jira and Confluence through an API token.',
    state: 'live',
    brandColor: '#0052CC',
    iconRef: 'atlassian',
    instructionsRef: 'atlassian',
  },
  {
    id: 'github',
    name: 'GitHub',
    authType: 'mcp.oauth',
    endpoint: 'https://api.githubcopilot.com/mcp',
    summary: 'Issues, pull requests, and repositories.',
    state: 'live',
    brandColor: '#181717',
    iconRef: 'github',
    instructionsRef: 'github',
  },
];
