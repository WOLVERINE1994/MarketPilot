// All market logic runs on India Standard Time (UTC+05:30, no daylight saving).
const IST_OFFSET_MS = 330 * 60 * 1000;

/** "YYYY-MM-DD" IST date of an epoch-ms timestamp. */
export const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** "HH:MM" IST time of an epoch-ms timestamp. */
export const istClock = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
/** Minutes since IST midnight. */
export const istMinutes = ms => { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const hhmmToMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Epoch ms for an IST wall-clock "YYYY-MM-DD HH:MM". */
export const istToMs = (day, hhmm = "00:00") => Date.parse(`${day}T${hhmm}:00+05:30`);
/** SmartAPI historical format "YYYY-MM-DD HH:MM" in IST. */
export const smartApiDate = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** Instrument-master expiry "19NOV2026" -> "2026-11-19". */
export function parseExpiry(value) {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/i.exec(String(value ?? "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toUpperCase()) + 1;
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]}`;
}
