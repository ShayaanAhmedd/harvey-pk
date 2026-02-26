type VectorRecord = {
  text: string;
  embedding: number[];
};

let store: VectorRecord[] = [];

export function saveVectors(vectors: VectorRecord[]) {
  store = vectors;
}

export function getVectors() {
  return store;
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) return -Infinity;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return -Infinity;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function findTopMatches(queryEmbedding: number[], topK = 3) {
  if (!store.length) {
    return [];
  }

  const scored = store.map(record => ({
    text: record.text,
    score: cosineSimilarity(queryEmbedding, record.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(item => item.text);
}