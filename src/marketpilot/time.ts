export const istDay = (time: string) => new Date(Date.parse(time) + 19800000).toISOString().slice(0, 10);
export const istMinute = (time: string) => new Date(Date.parse(time) + 19800000).toISOString().slice(11, 16);
export const displayTime = (time: string) => new Date(time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function fresh(time: string | null | undefined, now: string, seconds = 30) { const age = Date.parse(now) - Date.parse(time ?? ""); return Number.isFinite(age) && age >= -2000 && age <= seconds * 1000; }
