import { CONNECTOR_CATALOG } from '../main/connectorCatalog';
import { CONNECTOR_INSTRUCTIONS } from '../main/connectorInstructions';

// The grid degrades silently on bad catalog data; pin the invariants here.
// @see #331 #403

const HEX = /^#[0-9a-fA-F]{6}$/;

describe('connector catalog contract', () => {
  it('has unique ids', () => {
    const ids = CONNECTOR_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has https endpoints', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.endpoint).toMatch(/^https:\/\//u);
    }
  });

  it('resolves every instructionsRef to real instructions', () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.instructionsRef) {
        expect(CONNECTOR_INSTRUCTIONS[entry.instructionsRef]).toBeDefined();
      }
    }
  });

  it('gives every watchlisted entry an honest why', () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.state === 'watchlisted') {
        expect(entry.watchlistNote?.trim()).toBeTruthy();
      }
    }
  });

  it('uses valid hex brand colors', () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.brandColor) {
        expect(entry.brandColor).toMatch(HEX);
      }
    }
  });

  it('gives every live PAT entry token-setup instructions', () => {
    // The PAT modal requires a token; silent generic-copy fallback is a hole.
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.state === 'live' && entry.authType === 'mcp.pat') {
        expect(entry.instructionsRef).toBeTruthy();
        expect(CONNECTOR_INSTRUCTIONS[entry.instructionsRef!]).toBeDefined();
      }
    }
  });
});
