// Self-hosted embeddings via @xenova/transformers
// Model: BAAI/bge-small-en-v1.5 (384 dims, free, runs on CPU)
// After first run, model cached to ~/.cache and works offline.

import type { FeatureExtractionPipeline } from "@xenova/transformers";

let _pipeline: FeatureExtractionPipeline | null = null;
let _initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipeline) return _pipeline;
  if (!_initPromise) {
    _initPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // Allow remote model download on first use, then cache.
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      const pl = await pipeline(
        "feature-extraction",
        "Xenova/bge-small-en-v1.5",
        { quantized: true } // 8-bit quantized = faster, ~30MB
      );
      _pipeline = pl as FeatureExtractionPipeline;
      return _pipeline;
    })();
  }
  return _initPromise;
}

export async function embedTextLocal(text: string): Promise<number[]> {
  const pipeline = await getPipeline();
  // bge models recommend prefixing query inputs but corpus passages are plain.
  // Since this is corpus indexing, we use the text as-is.
  const output = await pipeline(text, {
    pooling: "mean",
    normalize: true,
  });
  // output.data is a Float32Array of length 384
  return Array.from(output.data as Float32Array);
}

// Batch helper to amortize pipeline overhead
export async function embedBatchLocal(texts: string[]): Promise<number[][]> {
  const pipeline = await getPipeline();
  const result: number[][] = [];
  for (const t of texts) {
    const out = await pipeline(t, { pooling: "mean", normalize: true });
    result.push(Array.from(out.data as Float32Array));
  }
  return result;
}

export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
