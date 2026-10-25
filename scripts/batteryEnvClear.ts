// Loaded first in the battery so the keys are gone before any mastra/langsmith import runs.
delete process.env.LANGSMITH_API_KEY;
delete process.env.LANGCHAIN_API_KEY;
delete process.env.LANGCHAIN_TRACING_V2;
delete process.env.LANGSMITH_TRACING;
export {};
