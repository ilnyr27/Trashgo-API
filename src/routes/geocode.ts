import { Hono } from 'hono';

const geocodeRoutes = new Hono();

// In-process cache so repeated identical addresses skip Nominatim
const cache = new Map<string, Array<{ lat: string; lon: string }>>();

// Nominatim can't resolve apartment-level addresses — strip them first.
// "Ул. Химиков, 45а, подъезд 1, этаж 3, кв. 35 Казань" → "Ул. Химиков, 45а Казань"
function cleanAddress(q: string): string {
  return q
    .replace(/,?\s*(подъезд|п-д|этаж|эт\.?|кв\.?|квартира|офис|оф\.?|комната|ком\.?)\s*[\d\w/-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

geocodeRoutes.get('/', async (c) => {
  const q = c.req.query('q');
  if (!q || q.trim().length < 3) return c.json([]);

  const key = cleanAddress(q.toLowerCase().trim());
  if (key.length < 3) return c.json([]);
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
