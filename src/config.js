const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

const port = Number.parseInt(process.env.PORT || "3000", 10);

const config = {
  port,
  callProvider: String(process.env.CALL_PROVIDER || "twilio").toLowerCase(),
  publicBaseUrl: trimTrailingSlash(
    process.env.PUBLIC_BASE_URL || `http://localhost:${port}`
  ),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openaiMock: String(process.env.OPENAI_MOCK || "false").toLowerCase() === "true",
  retellApiKey: process.env.RETELL_API_KEY || "",
  retellAgentId: process.env.RETELL_AGENT_ID || "",
  retellAgentVersion: Number.parseInt(process.env.RETELL_AGENT_VERSION || "", 10) || null,
  retellPhoneNumber: process.env.RETELL_PHONE_NUMBER || "",
  retellLlmId: process.env.RETELL_LLM_ID || "",
  retellToolSecret: process.env.RETELL_TOOL_SECRET || "",
  retellNumberNickname: process.env.RETELL_NUMBER_NICKNAME || "Hardvare AI Calling",
  plivoAuthId: process.env.PLIVO_AUTH_ID || "",
  plivoAuthToken: process.env.PLIVO_AUTH_TOKEN || "",
  plivoPhoneNumber: process.env.PLIVO_PHONE_NUMBER || "",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioApiKeySid: process.env.TWILIO_API_KEY_SID || "",
  twilioApiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  twilioMock: String(process.env.TWILIO_MOCK || "false").toLowerCase() === "true",
  espWifiSsid: process.env.WIFI_SSID || "Laksh-2.4G",
  espWifiPassword: process.env.WIFI_PASSWORD || "fundaz76",
  otaUrl: trimTrailingSlash(process.env.OTA_URL || "http://192.168.1.6"),
  otaUsername: process.env.OTA_USERNAME || "admin",
  otaPassword: process.env.OTA_PASSWORD || "admin",
  otaArduinoFqbn: process.env.OTA_ARDUINO_FQBN || "esp32:esp32:esp32s3",
  otaArduinoBoardOptions:
    process.env.OTA_ARDUINO_BOARD_OPTIONS || "USBMode=hwcdc,CDCOnBoot=cdc,UploadMode=default",
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

function isRetellConfigured() {
  return Boolean(config.retellApiKey && config.retellAgentId && config.retellPhoneNumber);
}

function isPlivoConfigured() {
  return Boolean(config.plivoAuthId && config.plivoAuthToken && config.plivoPhoneNumber);
}

function isCallProviderConfigured() {
  if (config.twilioMock) {
    return true;
  }

  if (config.callProvider === "plivo") {
    return isPlivoConfigured();
  }

  if (config.callProvider === "retell") {
    return isRetellConfigured();
  }

  if (config.callProvider === "twilio") {
    return isTwilioConfigured();
  }

  return false;
}

function isOpenAIConfigured() {
  return Boolean(config.openaiApiKey || config.openaiMock);
}

module.exports = {
  config,
  isCallProviderConfigured,
  isOpenAIConfigured,
  isPlivoConfigured,
  isRetellConfigured,
  isTwilioConfigured
};
