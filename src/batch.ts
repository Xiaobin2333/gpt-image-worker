export interface SettledBatchError {
  index: number;
  error: unknown;
}

export interface SettledBatchResult<T> {
  results: T[];
  errors: SettledBatchError[];
}

export async function runSettledBatch<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
): Promise<SettledBatchResult<T>> {
  const total = Math.max(0, Math.floor(count));
  const workerCount = Math.min(total, Math.max(1, Math.floor(concurrency)));
  const slots: Array<T | undefined> = new Array(total);
  const errors: SettledBatchError[] = [];
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < total) {
      const index = nextIndex++;
      try {
        slots[index] = await run(index);
      } catch (error) {
        errors.push({ index, error });
      }
    }
  });

  await Promise.all(workers);
  errors.sort((a, b) => a.index - b.index);
  return {
    results: slots.filter((value): value is T => value !== undefined),
    errors,
  };
}
