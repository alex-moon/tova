import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { connectorToolsetsForUser } from '../services/connectors/connectorService';
import { config } from '../config';

const router = express.Router();

type CapabilityStatus = 'ready' | 'unconfigured';

/* Built-in capability rows; `web_search` must not lie by absence. */
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

// Per-user state: built-ins plus live toolsets, deferred to discovery.
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
