import type { Client } from 'langsmith';

/* Duck-typed langsmith@0.8 dataset surface shared by the eval exporters. */
// @see #158 #394 #398
export interface LangSmithDatasetClient {
  hasDataset: (params: { datasetName: string }) => Promise<boolean>;
  createDataset: (name: string) => Promise<{ id: string }>;
  createExample: (
    input: unknown,
    output: unknown,
    opts?: { datasetName: string },
  ) => Promise<unknown>;
  listExamples?: (params: { datasetName: string }) => AsyncIterable<{ id: string }>;
  deleteExample?: (id: string) => Promise<unknown>;
}

export const asDatasetClient = (client: Client): LangSmithDatasetClient =>
  client as unknown as LangSmithDatasetClient;

/* Ensure the named dataset exists; created when absent. */
export const ensureDataset = async (
  ls: LangSmithDatasetClient,
  datasetName: string,
): Promise<void> => {
  if (!(await ls.hasDataset({ datasetName }))) await ls.createDataset(datasetName);
};
