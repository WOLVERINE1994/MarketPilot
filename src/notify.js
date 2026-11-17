/** Sends alerts to Telegram (if configured) and the console. Never throws. */
export class Notifier {
  constructor({ token, chatId } = {}, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
    this.token = token; this.chatId = chatId; this.fetch = fetchImpl; this.log = log;
  }
  get telegram() { return !!(this.token && this.chatId); }
  async send(text) {
    this.log(`\n🔔 ${text}\n`);
    if (!this.telegram) return false;
    try {
      const res = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      });
      return res.ok;
    } catch { return false; }
  }
}
