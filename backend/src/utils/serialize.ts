function isObjectIdLike(value: object): boolean {
  return typeof (value as { toHexString?: unknown }).toHexString === 'function';
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (isObjectIdLike(value)) return String(value);
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, seen));
  }

  const record = value as Record<string, unknown> & {
    toObject?: (options?: { virtuals?: boolean }) => Record<string, unknown>;
  };

  if (typeof record.toObject === 'function') {
    return normalize(record.toObject({ virtuals: false }), seen);
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === '__v') continue;
    output[key] = normalize(nested, seen);
  }
  if ('_id' in output && output._id !== undefined) {
    output.id = String(output._id);
    delete output._id;
  }
  return output;
}

/**
 * Convert Mongoose documents (including populated nested documents) to plain API
 * objects with `id` instead of `_id`. Dates remain Dates and are serialized by Express.
 */
export function serialize<T = any>(input: unknown): T {
  return normalize(input, new WeakSet()) as T;
}

export function serializeList<T = any>(items: unknown[]): T[] {
  return items.map((item) => serialize<T>(item));
}
