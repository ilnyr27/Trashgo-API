import { Hono } from 'hono';

const geocodeRoutes = new Hono();

// In-process cache so repeated identical addresses skip Nominatim
const cache = new Map<string, Array<{ lat: string; lon: string }>>();

geocodeRoutes.get('/', async (c) => {
  const q = c.req.query('q');
  if (!q || q.trim().length < 3) return c.json([]);

  const key = q.toLowerCase().trim();
  if (cache.has(key)) return c.json(cache.get(key));

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=1&countrycodes=ru`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'TrashGo/1.0 (trashgo.ru)',
        'Accept-Language': 'ru,en',
      },
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    const result = data.slice(0, 1).map((d) => ({ lat: d.lat, lon: d.lon }));
    cache.set(key, result);
    if (cache.size > 2000) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return c.json(result);
  } catch {
    return c.json([]);
  }
});

export default geocodeRoutes;
