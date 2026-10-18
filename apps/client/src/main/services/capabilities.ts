import axios from 'axios';

// Capabilities API client: per-user capability state; chat renders verbatim.
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
