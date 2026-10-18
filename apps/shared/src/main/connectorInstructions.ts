// Per-provider token-setup instructions for PAT connectors, as data.
// @see #332 #328
import type { CatalogEntry } from './connectorCatalog';

export interface ConnectorInstructionStep {
  title?: string;
  body: string;
}

export interface ConnectorInstructions {
  // One-line framing of what the token unlocks (what connecting grants).
  intro: string;
  steps: ConnectorInstructionStep[];
  // Narrow-vs-broad scope guidance, where the provider offers a choice.
  scopeNote?: string;
}

export const CONNECTOR_INSTRUCTIONS: Record<string, ConnectorInstructions> = {
  atlassian: {
    intro:
      'Atlassian’s remote MCP server authenticates with an API token tied to your Atlassian account.',
    steps: [
      {
        title: 'Open your Atlassian account security page',
        body: 'Go to id.atlassian.com and sign in with the account that has access to your Jira and Confluence sites.',
      },
      {
        title: 'Create an API token',
        body: 'Choose Security → API tokens → Create and manage API tokens, give it a name like “Tova”, and copy the token it shows you.',
      },
      {
        title: 'Paste it here',
        body: 'The token is submitted once, stored encrypted, and never shown again. Disconnecting deletes it.',
      },
    ],
    scopeNote:
      'Atlassian API tokens have no per-scope ticks: the token can reach exactly what your account can see. Use an account whose site access matches what you want the assistant to reach.',
  },
  github: {
    intro:
      'GitHub’s remote MCP server also supports OAuth sign-in, but requires a pre-registered app Tova cannot create automatically yet (#342) — connect with a fine-grained token for now.',
    steps: [
      {
        title: 'Open GitHub’s token settings',
        body: 'Go to github.com/settings/personal-access-tokens and choose “Generate” → “Fine-grained token”.',
      },
      {
        title: 'Pick the narrowest repository set that works',
        body: 'Select “Only select repositories” and choose the repos you want the assistant to reach. Broad “all repositories” access is rarely needed.',
      },
      {
        title: 'Choose permissions deliberately',
        body: 'Read-only “Contents” and “Issues”/“Pull requests” cover browsing. Add “Read and write” only if you want the assistant to be able to change them.',
      },
      {
        title: 'Paste the token here',
        body: 'The token is submitted once, stored encrypted, and never shown again.',
      },
    ],
    scopeNote:
      'Going narrow has a known cost: repositories you do not select — including ones in organizations you belong to — are invisible to the assistant, and tool listings will come back empty for them. If tools seem missing later, widen the repository selection and reconnect.',
  },
};

// Real content when the ref resolves; undefined falls back to generic copy.
export const instructionsFor = (entry: CatalogEntry): ConnectorInstructions | undefined =>
  entry.instructionsRef ? CONNECTOR_INSTRUCTIONS[entry.instructionsRef] : undefined;
