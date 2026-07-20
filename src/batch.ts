export interface SettledBatchError {
  index: number;
  error: unknown;
}

export interface SettledBatchResult<T> {
  results: T[];
  errors: SettledBatchError[];
}

export interface RetriedBatchOptions {
  maxRetries: number;
  shouldRetry: (error: unknown) => boolean;
  beforeRetry?: (errors: SettledBatchError[], nextAttempt: number) => void | Promise<void>;
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

export async function runSettledBatchWithRetries<T>(
  count: number,
  concurrency: number,
  run: (index: number, attempt: number) => Promise<T>,
  options: RetriedBatchOptions,
): Promise<SettledBatchResult<T>> {
  const total = Math.max(0, Math.floor(count));
  const slots: Array<T | undefined> = new Array(total);
  const finalErrors: SettledBatchError[] = [];
  let pending = Array.from({ length: total }, (_, index) => index);
  const maxAttempts = Math.max(1, Math.floor(options.maxRetries) + 1);

  for (let attempt = 1; pending.length > 0 && attempt <= maxAttempts; attempt++) {
    const current = pending;
    const batch = await runSettledBatch(
      current.length,
      Math.min(current.length, Math.max(1, Math.floor(concurrency))),
      async (slot) => ({ index: current[slot]!, value: await run(current[slot]!, attempt) }),
    );
    for (const result of batch.results) slots[result.index] = result.value;

    const retryErrors: SettledBatchError[] = [];
    for (const item of batch.errors) {
      const mapped = { index: current[item.index]!, error: item.error };
      if (attempt < maxAttempts && options.shouldRetry(item.error)) retryErrors.push(mapped);
      else finalErrors.push(mapped);
    }
    pending = retryErrors.map((item) => item.index);
    if (pending.length > 0 && options.beforeRetry) {
      await options.beforeRetry(retryErrors, attempt + 1);
    }
  }

  finalErrors.sort((a, b) => a.index - b.index);
  return {
    results: slots.filter((value): value is T => value !== undefined),
    errors: finalErrors,
  };
}
