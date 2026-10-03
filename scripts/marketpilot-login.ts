import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkLoginConfig, loginAndSave, LoginError } from "../src/marketpilot/login";

const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
type Key = { name?: string; ctrl?: boolean; meta?: boolean };

function hiddenPrompt(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin, output = process.stdout;
    const wasRaw = input.isRaw;
    let value = "";
    function finish(error?: LoginError) {
      input.removeListener("keypress", keypress);
      process.removeListener("SIGTERM", terminated);
      input.setRawMode(wasRaw); input.pause(); output.write("\n");
      if (error) reject(error); else resolve(value);
      value = "";
    }
    function terminated() { finish(new LoginError("Login cancelled; no token was saved.")); }
    function keypress(text: string | undefined, key: Key) {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) return terminated();
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = Array.from(value).slice(0, -1).join(""); return; }
      if (!key.ctrl && !key.meta && !["up", "down", "left", "right", "escape", "delete", "tab"].includes(key.name ?? "") && text)
        value += text.replace(/[\x00-\x1f\x7f]/g, "");
    }
    output.write(`${label}: `);
    emitKeypressEvents(input); input.setRawMode(true);
    input.on("keypress", keypress); process.once("SIGTERM", terminated); input.resume();
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new LoginError("Run this helper directly in an interactive terminal; redirected input/output is not supported.");
  await checkLoginConfig(envFile);
  console.log("SmartAPI local login. Input is hidden. Press Ctrl+C to cancel.");
  const clientcode = await hiddenPrompt("Angel One client code");
  const password = await hiddenPrompt("Angel One PIN/password");
  const totp = await hiddenPrompt("Current 6-digit authenticator code");
  console.log("Authenticating with Angel One...");
  await loginAndSave(envFile, { clientcode, password, totp });
  console.log("Login succeeded. ANGEL_ACCESS_TOKEN saved to .env.local. JWT, PIN/password and authenticator code were not printed; only the JWT was saved.");
  console.log("Restart MarketPilot and its worker, then run: npm.cmd run marketpilot:check");
}
main().catch(error => {
  console.error(error instanceof LoginError ? error.message : "Login helper failed. No credentials or raw errors are displayed.");
  process.exitCode = 1;
});
