import axios from 'axios';

// Capabilities API client: the server's per-user capability state; the chat renders it verbatim.
// @see #366

export interface CapabilityTool {
  name: string;
  label: string;
  status: 'ready' | 'unconfigured';
}

export interface ConnectorCapabilities {
  name: string;
  tools: { name: string; description: string }[];
}

export interface Capabilities {
  tools: CapabilityTool[];
  connectors: ConnectorCapabilities[];
}

const capabilitiesService = {
  async get(): Promise<Capabilities> {
    const res = await axios.get<Capabilities>('/api/capabilities');
    return res.data;
  },
};

export default capabilitiesService;
