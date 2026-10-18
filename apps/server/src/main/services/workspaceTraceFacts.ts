import { isWorkspaceMemoryEnabled } from './workspaceRetrievalService';

/* Workspace-memory facts for traces: gate label + flat identifier metadata. */
// @see #308 #310 #305

export type WorkspaceGate = 'yes' | 'no' | 'timeout' | 'off';

export const workspaceGateFrom = (workspaceBlock: string, skip: boolean): WorkspaceGate => {
  if (skip || !isWorkspaceMemoryEnabled()) return 'off';
  return workspaceBlock ? 'yes' : 'no';
};

export const workspaceTraceMetadata = (
  gate: WorkspaceGate,
  workspaceBlock: string,
): Record<string, string | number> => ({
  tova_workspace_gate: gate,
  tova_workspace_hits: workspaceBlock ? workspaceBlock.split('\n').length : 0,
});
