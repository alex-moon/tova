import {
  BookOpen,
  Bug,
  Cloud,
  CreditCard,
  Database,
  GitBranch,
  MessageSquare,
  Search,
  Triangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/*
 * Curated suggestions for the MCP add flow (issue #80), mirrored from the
 * community "awesome-mcp-servers" catalog (punkpeye/awesome-mcp-servers).
 * Remote HTTP endpoints only — Tova deliberately supports HTTP transports
 * exclusively (#36 excludes stdio). Clicking one prefills the add form.
 */

export interface McpSuggestion {
  name: string;
  url: string;
  description: string;
  icon: LucideIcon;
}

export const MCP_SUGGESTIONS: McpSuggestion[] = [
  {
    name: 'GitHub (Copilot MCP)',
    url: 'https://api.githubcopilot.com/mcp/',
    description: 'repos, issues, PRs, workflows',
    icon: GitBranch,
  },
  {
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    description: 'pages, databases, workspaces',
    icon: BookOpen,
  },
  {
    name: 'Slack',
    url: 'https://mcp.slack.com/mcp',
    description: 'channels, messages, search',
    icon: MessageSquare,
  },
  {
    name: 'Stripe',
    url: 'https://mcp.stripe.com',
    description: 'payments, subscriptions, invoices',
    icon: CreditCard,
  },
  {
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    description: 'error tracking, performance',
    icon: Bug,
  },
  {
    name: 'Supabase',
    url: 'https://mcp.supabase.com/mcp',
    description: 'postgres, auth, storage',
    icon: Database,
  },
  {
    name: 'Cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    description: 'workers, KV, R2, DNS',
    icon: Cloud,
  },
  {
    name: 'Vercel',
    url: 'https://mcp.vercel.com',
    description: 'deployments, logs, environments',
    icon: Triangle,
  },
  {
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    description: 'live library docs for AI prompts',
    icon: BookOpen,
  },
  {
    name: 'Exa',
    url: 'https://mcp.exa.ai/mcp',
    description: 'semantic web search',
    icon: Search,
  },
];
