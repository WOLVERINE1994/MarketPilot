# Run MarketPilot 24×7 on a cloud server and use it from your phone

With this setup you don't need a laptop. A small cloud server runs MarketPilot all day and logs in to Angel One by itself every morning. Your phone gets:

- **Telegram alerts** for every BUY CE / BUY PE / EXIT, even when the phone is locked.
- **The dashboard as an app**, with its own home-screen icon and a full-screen view.

The connection between your phone and the server is **private**. It uses [Tailscale](https://tailscale.com), which is free for personal use, so the dashboard is never exposed to the public internet, and it still has a password.

**Time needed:** about 20 minutes, once. You'll need a laptop or desktop with internet for this one-time setup. After that, the phone is enough.

---

## Step 1 — Rent a small Linux server

Any provider works. Pick a **Mumbai or Bangalore** location, the **Ubuntu 24.04** image, and **1 GB RAM** or more. One option:

- **AWS Lightsail → Mumbai → Linux/Unix → Ubuntu 24.04 → the 1 GB plan.**

Lightsail plans are billed by the hour, with a fixed monthly cap. The smallest 512 MB plan also works, because the installer adds swap memory, but 1 GB is more comfortable.

After the server is created, open its **browser-based SSH terminal** (Lightsail has a "Connect using SSH" button).

## Step 2 — Get the code onto the main branch

The new MarketPilot is in Pull Request #1. On GitHub, open the PR and tap **Merge pull request**. You can do this from the GitHub app on your phone.

## Step 3 — Run the one-command installer

In the server's SSH terminal, paste:

```bash
curl -fsSL https://raw.githubusercontent.com/WOLVERINE1994/MarketPilot/main/deploy/install.sh | sudo bash
```

It asks for your details (hidden while typing). They are stored only on your server:

| It asks for | Where to find it |
|---|---|
| SmartAPI key | smartapi.angelone.in → My Apps |
| Client code + PIN | Your Angel One login |
| **TOTP secret** | smartapi.angelone.in/enable-totp. Required on a server, so it can log in every morning without you. |
| Telegram bot token + chat id | @BotFather and @userinfobot in Telegram (see README) |
| Dashboard password | Choose one, 8+ characters |

The installer then:

1. Installs Node.js 22 and MarketPilot.
2. Checks your Angel One login.
3. Starts MarketPilot as a service that restarts automatically if it crashes or the server reboots. It also restarts every morning at 08:45 IST for a fresh login and the current month's contracts.
4. Installs Tailscale and shows a **sign-in link**. Open it and sign in with Google or another account. **Use the same account on your phone.**

The installer finishes by printing your private dashboard address, for example `https://marketpilot-server.tail1234.ts.net`.

> The first time, Tailscale may ask you to **enable HTTPS** for your network. Open the link it prints (or Tailscale admin → DNS → enable MagicDNS and HTTPS certificates), then run `sudo tailscale serve --bg 3100` once more.

## Step 4 — Set up your phone

1. Install **Tailscale** from the Play Store and sign in with the same account. Leave it switched on.
2. Open the dashboard address in **Chrome** and sign in with your dashboard password. You stay signed in for 30 days.
3. Tap **⬇ Install app**, or Chrome menu ⋮ → **Add to Home screen**. MarketPilot now has its own icon and opens like an app.
4. Make sure you've started a chat with your Telegram bot, so alerts reach you.

---

## Everyday commands (in the server SSH terminal)

| What | Command |
|---|---|
| See live logs | `sudo journalctl -u marketpilot -f` |
| Restart | `sudo systemctl restart marketpilot` |
| Change settings | `sudo nano /opt/marketpilot/.env`, then restart |
| Update to the latest code | `sudo bash /opt/marketpilot/deploy/install.sh` (keeps your settings and history) |
| Stop | `sudo systemctl stop marketpilot` |

## Good to know

- **Phone offline or Tailscale off?** The app shows a "can't reach MarketPilot" page. The server keeps running and Telegram alerts still arrive.
- **Your Angel One details** live only in `/opt/marketpilot/.env` on your server. Only the server's admin can read the file. They are never sent anywhere except Angel One's login.
- **Your GitHub repository is public.** That's fine, because it contains no passwords or keys. Never put your `.env` into it.
- MarketPilot only **reads market data and sends alerts**. It cannot place orders on your account.
