# Hardware Builder

This project is an Express and OpenAI voice workflow for guided ESP32 builds. A saved user account opens the web page, signs in to the dashboard, enters a phone number, PIN, and ESP32 ID, and the server places an outbound call through a configurable voice provider such as Retell, Plivo, or Twilio. During the call, the bot:

- verifies the PIN
- asks what the caller wants to build
- generates ESP32 code and one-pin-at-a-time wiring steps
- waits for the caller to say `ok` before moving to the next connection
- compiles the generated sketch into an OTA firmware binary
- runs a safety-first preflight scan before the final upload
- opens the OTA login page in Chrome after wiring is complete
- signs in, chooses the firmware file automatically, and clicks Update
- falls back to direct USB flashing with Arduino CLI if the OTA page is unavailable

## What it does

1. The dashboard uses saved local accounts instead of any Gmail login.
2. The browser form collects a phone number, numeric PIN, and ESP32 device ID.
3. The backend stores the PIN as a salted hash.
4. The backend asks the configured voice provider to place the call.
5. After the correct PIN, the call asks what the caller wants to build.
6. The backend uses OpenAI to generate code plus step-by-step pin instructions.
7. The backend validates the generated sketch by compiling it for `esp32:esp32:esp32s3` before the build is marked ready.
8. If the sketch needs Arduino libraries that are not installed yet, the backend installs them automatically with Arduino CLI before retrying validation.
9. If compilation still fails, the backend can ask OpenAI to repair the sketch and retry validation automatically.
10. The call advances only after the caller says `ok`.
11. The backend saves the generated sketch into `generated/`.
12. The backend compiles the validated sketch into an OTA `.bin` firmware file.
13. Before the final upload, the backend flashes a safety preflight sketch that checks Wi-Fi state, reset reason, I2C devices, GPIO snapshot, and brownout warnings.
14. The backend opens the OTA web page at `http://192.168.1.6/`, signs in automatically, chooses the firmware, and clicks Update.
15. If the OTA page does not come back, the backend can recover by flashing the firmware over USB with Arduino CLI instead of requiring an IDE.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your voice-provider and OpenAI credentials.

3. Expose the local server through a public HTTPS URL. This project is currently deployed through a Cloudflare Tunnel on `https://hardvare.com`, but any public HTTPS domain or tunnel works as long as it forwards to `http://localhost:3000`.

4. Put that public HTTPS address into `PUBLIC_BASE_URL`.

5. Start the server:

   ```bash
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000), sign in with the default admin account `esphardvare / espadmin` or create a saved user account, then use the dashboard.

For this workspace, `scripts\\start-app-server.cmd` starts the local app server and `scripts\\start-cloudflare-tunnel.cmd` starts the named Cloudflare tunnel that serves `https://hardvare.com`.

## Environment variables

- `PORT` local port for the Express server.
- `PUBLIC_BASE_URL` public URL that the voice provider can reach for webhooks.
- `CALL_PROVIDER` live provider name. Use `retell`, `plivo`, or `twilio`. Default is `twilio`.
- `OPENAI_API_KEY` required for live code and pin generation.
- `OPENAI_MODEL` OpenAI model name. Default is `gpt-4.1-mini`.
- `OPENAI_MOCK=true` skips the real OpenAI API and uses a local mock build plan for testing.
- `RETELL_API_KEY` Retell API key.
- `RETELL_LLM_ID` optional saved Retell LLM ID for your agent setup.
- `RETELL_AGENT_ID` Retell voice agent ID used for outbound calls.
- `RETELL_AGENT_VERSION` optional published or draft agent version override.
- `RETELL_PHONE_NUMBER` Retell phone number used as the caller ID.
- `PLIVO_AUTH_ID` Plivo auth ID.
- `PLIVO_AUTH_TOKEN` Plivo auth token.
- `PLIVO_PHONE_NUMBER` Plivo number used as the caller ID.
- `TWILIO_ACCOUNT_SID` Twilio account SID.
- `TWILIO_AUTH_TOKEN` Twilio auth token.
- `TWILIO_API_KEY_SID` optional Twilio API Key SID. Use this with `TWILIO_API_KEY_SECRET` as an alternative to `TWILIO_AUTH_TOKEN`.
- `TWILIO_API_KEY_SECRET` optional Twilio API Key secret.
- `TWILIO_PHONE_NUMBER` Twilio number used as the caller ID.
- `TWILIO_MOCK=true` skips the real Twilio API and simulates outbound calls for local testing.
- `OTA_URL` local OTA page URL. Default is `http://192.168.1.6`.
- `OTA_USERNAME` default `admin`.
- `OTA_PASSWORD` default `admin`.
- `OTA_ARDUINO_FQBN` board target used to compile the OTA firmware. Default is `esp32:esp32:esp32s3`.
- `OTA_ARDUINO_BOARD_OPTIONS` optional board options passed to Arduino CLI. The default enables USB CDC on boot for ESP32-S3 recovery and diagnostics.
- `ARDUINO_CLI_PATH` optional override for the Arduino CLI executable.
- `ARDUINO_CLI_CONFIG_PATH` optional override for the Arduino CLI config file.
- `ADMIN_USERNAME` seeded admin username. Default is `esphardvare`.
- `ADMIN_PASSWORD` seeded admin password. Default is `espadmin`.
- `ADMIN_SESSION_SECRET` signing secret for the saved-account login cookie.
- `CHROME_EXECUTABLE_PATH` optional override for the local Chrome or Edge executable.

## Notes

- Phone numbers can include spaces, dashes, parentheses, `00`, or a leading `+`. The server normalizes them and sends the destination to the configured call provider without app-side country blocking.
- The PIN must be 4 to 8 digits.
- The ESP32 ID accepts letters, numbers, and hyphens.
- Runtime caller records are stored in `data/callers.json`.
- Saved accounts are also stored in `data/callers.json`.
- Generated sketches are stored in `generated/`.
- Compiled OTA firmware binaries are stored in `.ota-builds/`.
- Missing Arduino libraries referenced by generated code are downloaded and installed automatically through Arduino CLI.
- The safety preflight scan is allowed to block the final firmware upload when the board cannot prove safe state or reconnect health.
- In mock mode, the UI still works, but no real phone call is placed.
- For live mode with Retell, set `CALL_PROVIDER=retell` together with `RETELL_API_KEY`, `RETELL_AGENT_ID`, and `RETELL_PHONE_NUMBER`.
- For live mode with Plivo, set `CALL_PROVIDER=plivo` together with `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, and `PLIVO_PHONE_NUMBER`.
- For live mode with Twilio, set `CALL_PROVIDER=twilio` and then use either `TWILIO_AUTH_TOKEN` or the pair `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`.
- The default admin account can see all sessions. Regular saved accounts only see their own sessions.
- When using Cloudflare Tunnel, keep the local tunnel token and logs out of Git. This repo ignores `.cloudflared/`, `.cloudflared-extract/`, and `cloudflared*.log`.
- The app accepts any normalized destination number, but live call delivery still depends on your chosen provider, account permissions, caller ID rules, and carrier support.
