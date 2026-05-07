const buckets = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

/**
 * Returns 0 if the request is allowed, or seconds until the window resets if blocked.
 */
export function rateLimit(key: string, max = 5, windowMs = 60 * 60 * 1000): number {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }

  if (entry.count >= max) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count += 1;
  return 0;
}
