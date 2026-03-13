const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

const port = Number.parseInt(process.env.PORT || "3000", 10);

const config = {
  port,
  publicBaseUrl: trimTrailingSlash(
    process.env.PUBLIC_BASE_URL || `http://localhost:${port}`
  ),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openaiMock: String(process.env.OPENAI_MOCK || "false").toLowerCase() === "true",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioApiKeySid: process.env.TWILIO_API_KEY_SID || "",
  twilioApiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  twilioMock: String(process.env.TWILIO_MOCK || "false").toLowerCase() === "true",
  otaUrl: trimTrailingSlash(process.env.OTA_URL || "http://192.168.1.6"),
  otaUsername: process.env.OTA_USERNAME || "admin",
  otaPassword: process.env.OTA_PASSWORD || "admin",
  otaArduinoFqbn: process.env.OTA_ARDUINO_FQBN || "esp32:esp32:esp32s3",
  arduinoCliPath:
    process.env.ARDUINO_CLI_PATH ||
    path.join(__dirname, "..", ".tools", "arduino-cli", "arduino-cli.exe"),
  arduinoCliConfigPath:
    process.env.ARDUINO_CLI_CONFIG_PATH ||
    path.join(__dirname, "..", ".tools", "arduino-cli.yaml"),
  otaBuildDir: path.join(__dirname, "..", ".ota-builds"),
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || "",
  adminUsername: process.env.ADMIN_USERNAME || "esphardvare",
  adminPassword: process.env.ADMIN_PASSWORD || "espadmin",
  adminSessionSecret:
    process.env.ADMIN_SESSION_SECRET || "hardware-builder-admin-session-secret",
  maxPinAttempts: 3,
  dataFile: path.join(__dirname, "..", "data", "callers.json"),
  generatedDir: path.join(__dirname, "..", "generated")
};

function isTwilioConfigured() {
  return Boolean(
    config.twilioAccountSid &&
      (config.twilioAuthToken ||
        (config.twilioApiKeySid && config.twilioApiKeySecret)) &&
      config.twilioPhoneNumber
  );
}

function isOpenAIConfigured() {
  return Boolean(config.openaiApiKey || config.openaiMock);
}

module.exports = {
  config,
  isOpenAIConfigured,
  isTwilioConfigured
};
