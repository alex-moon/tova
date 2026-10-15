import { isWorkspaceMemoryEnabled } from './workspaceRetrievalService';

/*
 * #308/#310: workspace-memory facts for the traces view.
 *
 * With the enrichment gate retired (#310), retrieval runs on every non-ZDR text
 * turn and there is no vote left to report — the label now describes the
 * retrieval outcome itself:
 *
 *   'off'     image turn, kill switch, or workspace memory disabled
 *   'yes'     retrieval ran and the rendered block carries slices
 *   'no'      retrieval ran and produced nothing (no overlap, or #305's cut
 *             removed every candidate — the graceful-refusal path)
 *
 * ('timeout' — the retired guard's slow-aux label — is no longer produced, but
 * stays a valid value so historical traces keep rendering.)
 *
 * `workspaceTraceMetadata` renders the facts as flat, namespaced,
 * identifier-only metadata keys — no user content — under the contract
 * `TraceContext.metadata` already documents. The hit count is the rendered
 * block's bullet count, so `yes · 0` is distinguishable from a refusal.
 */

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
