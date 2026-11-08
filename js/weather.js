// Wind and temperature from Open-Meteo (free, no key). Wind direction is where it blows FROM.
import { cardinal } from './geo.js';

let cache = { key: '', t: 0, data: null };

export async function getWind(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cache.key === key && Date.now() - cache.t < 15 * 60000) return cache.data;
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability' +
    '&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_hours=18&timezone=auto';
  const r = await fetch(url);
  if (!r.ok) throw new Error('weather ' + r.status);
  const j = await r.json();
  const c = j.current || {};
  const now = Date.now();
  const hourly = (j.hourly?.time || []).map((t, i) => ({
    time: new Date(t), temp: j.hourly.temperature_2m[i], speed: j.hourly.wind_speed_10m[i],
    dir: j.hourly.wind_direction_10m[i], gust: j.hourly.wind_gusts_10m[i], pop: j.hourly.precipitation_probability?.[i],
  })).filter((h) => +h.time > now - 3600000);
  const data = { temp: c.temperature_2m, speed: c.wind_speed_10m, gust: c.wind_gusts_10m, dir: c.wind_direction_10m,
    card: cardinal(c.wind_direction_10m ?? 0), hourly };
  cache = { key, t: Date.now(), data };
  return data;
}

/** Arrow pointing where the wind is blowing TO (scent drifts this way). */
export const windArrow = (dirFrom, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${(dirFrom + 180) % 360}deg);vertical-align:-3px">` +
  '<path d="M12 2 L18 20 L12 15 L6 20 Z" fill="currentColor"/></svg>';
