// One-off smoke test for the local granite embedder. Not part of the test
// suite (it loads a 94MB model). Run: `bun run scripts/smoke-granite.ts`.
import { runLocalEmbed } from "../src/embed/local.ts";

function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const texts = [
  "The cat sat on the mat.", // 0
  "A feline rested on the rug.", // 1 near-paraphrase (en)
  "Kedi halının üzerine oturdu.", // 2 Turkish paraphrase of 0
  "Merhaba dünya, bugün hava çok güzel.", // 3 Turkish unrelated
  "The cat sat on the mat.", // 4 dup of 0
];

const t0 = Date.now();
const { vectors, dimensions } = await runLocalEmbed(texts);
console.log(`loaded+embedded ${vectors.length} texts in ${Date.now() - t0}ms`);
console.log("dimensions:", dimensions);
console.log("cos(0,1) en paraphrase :", cos(vectors[0], vectors[1]).toFixed(3));
console.log("cos(0,2) en↔tr paraphrase:", cos(vectors[0], vectors[2]).toFixed(3));
console.log("cos(0,3) en↔tr unrelated :", cos(vectors[0], vectors[3]).toFixed(3));
console.log("cos(0,4) exact duplicate :", cos(vectors[0], vectors[4]).toFixed(3));

// Sanity expectations: dup≈1.0; paraphrase (en & tr) > unrelated; en↔tr paraphrase > en↔tr unrelated.
const ok =
  dimensions === 384 &&
  cos(vectors[0], vectors[4]) > 0.98 &&
  cos(vectors[0], vectors[1]) > cos(vectors[0], vectors[3]) &&
  cos(vectors[0], vectors[2]) > cos(vectors[0], vectors[3]);
console.log(ok ? "\nPASS" : "\nFAIL");
