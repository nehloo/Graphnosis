export function jaccardSimilarity(setA: string[], setB: string[]): number {
  if (setA.length === 0 || setB.length === 0) return 0;

  // NFD normalize + lowercase for consistent comparison across scripts
  // This ensures "café" matches "cafe", "Müller" matches "müller", etc.
  const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const a = new Set(setA.map(normalize));
  const b = new Set(setB.map(normalize));

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}
