import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { connectorToolsetsForUser } from '../services/connectorService';
import { config } from '../config';

const router = express.Router();

type CapabilityStatus = 'ready' | 'unconfigured';

/* Built-in capability rows; `web_search` is the one config-gated tool, and it must report `unconfigured` rather than lie by absence. */
// @see #366
export const builtInCapabilities = (): {
  name: string;
  label: string;
  status: CapabilityStatus;
}[] => [
  {
    name: 'web_search',
    label: 'Search the web',
    status: config.search.braveApiKey ? 'ready' : 'unconfigured',
  },
  { name: 'fetch_url', label: 'Read a web page', status: 'ready' },
  { name: 'list_files', label: 'List your files', status: 'ready' },
  { name: 'read_file', label: 'Read a file', status: 'ready' },
  { name: 'generate_file', label: 'Create a file', status: 'ready' },
  { name: 'edit_file', label: 'Edit a file', status: 'ready' },
  { name: 'current_datetime', label: 'Current date and time', status: 'ready' },
  { name: 'calculate', label: 'Calculations', status: 'ready' },
  { name: 'delegate_task', label: 'Run background tasks', status: 'ready' },
];

// The per-user capability state: built-ins plus the live connector toolsets, which are deferred behind `search_tools` discovery.
// @see #366
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const toolsets = await connectorToolsetsForUser(req.user?.id);
    const connectors = Object.entries(toolsets).map(([name, tools]) => ({
      name,
      tools: Object.entries(tools).map(([toolName, tool]) => ({
        name: toolName,
        description: tool.description ?? '',
      })),
    }));
    res.json({ tools: builtInCapabilities(), connectors });
  } catch (err) {
    console.error('Capabilities error:', err);
    res.status(500).json({ message: 'Error reading capabilities' });
  }
});

export default router;
