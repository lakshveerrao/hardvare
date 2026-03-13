# Hardware Builder

This project is an Express, Twilio, and OpenAI voice workflow for guided ESP32 builds. An admin opens the web page, signs in to the dashboard, enters a phone number, PIN, and ESP32 ID, and the server places an outbound call. During the call, the bot:

- verifies the PIN
- asks what the caller wants to build
- generates ESP32 code and one-pin-at-a-time wiring steps
- waits for the caller to say `ok` before moving to the next connection
- compiles the generated sketch into an OTA firmware binary
- opens the OTA login page in Chrome after wiring is complete
- signs in, chooses the firmware file automatically, and clicks Update

## What it does

1. The dashboard requires an admin username and password instead of any Gmail login.
2. The browser form collects a phone number, numeric PIN, and ESP32 device ID.
3. The backend stores the PIN as a salted hash.
4. The backend asks Twilio to place the call.
5. After the correct PIN, the call asks what the caller wants to build.
6. The backend uses OpenAI to generate code plus step-by-step pin instructions.
7. The call advances only after the caller says `ok`.
8. The backend saves the generated sketch into `generated/`.
9. The backend compiles the generated sketch into an OTA `.bin` firmware file.
10. The backend opens the OTA web page at `http://192.168.1.6/`, signs in automatically, chooses the firmware, and clicks Update.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Twilio and OpenAI credentials.

3. Expose the local server through a public HTTPS URL. For example, with `ngrok`:

   ```bash
   ngrok http 3000
   ```

4. Put the public HTTPS address into `PUBLIC_BASE_URL`.

5. Start the server:

   ```bash
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000), sign in with username `esphardvare` and password `espadmin`, then use the dashboard.

## Environment variables

- `PORT` local port for the Express server.
- `PUBLIC_BASE_URL` public URL that Twilio can reach for voice webhooks.
- `OPENAI_API_KEY` required for live code and pin generation.
- `OPENAI_MODEL` OpenAI model name. Default is `gpt-4.1-mini`.
- `OPENAI_MOCK=true` skips the real OpenAI API and uses a local mock build plan for testing.
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
- `ARDUINO_CLI_PATH` optional override for the Arduino CLI executable.
- `ARDUINO_CLI_CONFIG_PATH` optional override for the Arduino CLI config file.
- `ADMIN_USERNAME` dashboard admin username. Default is `esphardvare`.
- `ADMIN_PASSWORD` dashboard admin password. Default is `espadmin`.
- `ADMIN_SESSION_SECRET` signing secret for the admin login cookie.
- `CHROME_EXECUTABLE_PATH` optional override for the local Chrome or Edge executable.

## Notes

- The phone number must be entered in E.164 format, such as `+919876543210`.
- The PIN must be 4 to 8 digits.
- The ESP32 ID accepts letters, numbers, and hyphens.
- Runtime caller records are stored in `data/callers.json`.
- Generated sketches are stored in `generated/`.
- Compiled OTA firmware binaries are stored in `.ota-builds/`.
- In mock mode, the UI still works, but no real phone call is placed.
- For live mode, keep `TWILIO_ACCOUNT_SID` set and then use either `TWILIO_AUTH_TOKEN` or the pair `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`.
- Twilio's current India voice guidelines say outbound calls to `+91` numbers must come from an international non-Indian caller ID, so an Indian verified caller ID will be rejected for those calls.
