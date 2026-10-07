interface CacheEntry {
  value: any;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();

export async function get<T>(
  key: string,
  factory: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && entry.expiry > now) {
    return entry.value as T;
  }

  const value = await factory();
  cache.set(key, { value, expiry: now + ttlSeconds * 1000 });
  return value;
}
