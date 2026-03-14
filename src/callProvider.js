const twilio = require("twilio");
const { Buffer } = require("buffer");
const {
  config,
  isCallProviderConfigured,
  isPlivoConfigured,
  isRetellConfigured,
  isTwilioConfigured
} = require("./config");

function hasPublicWebhookBaseUrl() {
  try {
    const url = new URL(config.publicBaseUrl);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    return !localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function createTwilioClient() {
  if (config.twilioApiKeySid && config.twilioApiKeySecret) {
    return twilio(config.twilioApiKeySid, config.twilioApiKeySecret, {
      accountSid: config.twilioAccountSid
    });
  }

  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

async function placePlivoCall(phoneNumber, answerUrl) {
  const response = await fetch(
    `https://api.plivo.com/v1/Account/${encodeURIComponent(config.plivoAuthId)}/Call/`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${config.plivoAuthId}:${config.plivoAuthToken}`
        ).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.plivoPhoneNumber,
        to: phoneNumber,
        answer_url: answerUrl,
        answer_method: "POST"
      })
    }
  );

  const rawText = await response.text();
  let payload = {};

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = {
        message: rawText
      };
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload.error || payload.message || `Plivo could not start the call to ${phoneNumber}.`
    );
    error.statusCode = response.status;
    throw error;
  }

  return {
    sid:
      payload.request_uuid ||
      payload.api_id ||
      `PLIVO-${Date.now()}`,
    provider: "plivo",
    url: answerUrl
  };
}

async function placeRetellCall(phoneNumber, user = null) {
  const dynamicVariables = {
    session_id: user?.id || "",
    esp32_id: user?.esp32Id || "",
    phone_number: phoneNumber,
    owner_username: user?.ownerUsername || "",
    public_base_url: config.publicBaseUrl,
    ota_url: config.otaUrl
  };

  const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.retellApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from_number: config.retellPhoneNumber,
      to_number: phoneNumber,
      override_agent_id: config.retellAgentId,
      override_agent_version:
        Number.isInteger(config.retellAgentVersion) && config.retellAgentVersion >= 0
          ? config.retellAgentVersion
          : undefined,
      metadata: {
        hardvareSessionId: user?.id || null,
        esp32Id: user?.esp32Id || null,
        ownerUsername: user?.ownerUsername || null
      },
      retell_llm_dynamic_variables: dynamicVariables
    })
  });

  const rawText = await response.text();
  let payload = {};

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = {
        message: rawText
      };
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload.error || payload.message || `Retell could not start the call to ${phoneNumber}.`
    );
    error.statusCode = response.status;
    throw error;
  }

  return {
    sid:
      payload.call_id ||
      payload.phone_call_response?.call_id ||
      `RETELL-${Date.now()}`,
    provider: "retell",
    url: null
  };
}

async function placeTwilioCall(phoneNumber, answerUrl) {
  const client = createTwilioClient();

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: config.twilioPhoneNumber,
      url: answerUrl,
      method: "POST"
    });

    return {
      sid: call.sid,
      provider: "twilio",
      url: answerUrl
    };
  } catch (error) {
    error.message =
      error.message ||
      `Twilio could not start the call to ${phoneNumber}. Check the destination number, caller ID, and account permissions.`;
    throw error;
  }
}

async function placeOutboundCall({ phoneNumber, answerUrl, user = null }) {
  if (config.twilioMock) {
    return {
      sid: `MOCK-${Date.now()}`,
      mock: true,
      provider: "mock",
      url: answerUrl
    };
  }

  if (!isCallProviderConfigured()) {
    if (config.callProvider === "retell") {
      throw new Error(
        "Retell is not configured. Set RETELL_API_KEY, RETELL_AGENT_ID, and RETELL_PHONE_NUMBER, or enable TWILIO_MOCK=true."
      );
    }

    if (config.callProvider === "plivo") {
      throw new Error(
        "Plivo is not configured. Set PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, and PLIVO_PHONE_NUMBER, or enable TWILIO_MOCK=true."
      );
    }

    throw new Error(
      "No live call provider is configured. Set CALL_PROVIDER=plivo with PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, and PLIVO_PHONE_NUMBER, or enable TWILIO_MOCK=true."
    );
  }

  if (!hasPublicWebhookBaseUrl()) {
    throw new Error(
      "PUBLIC_BASE_URL must be a public URL that the call provider can reach. Start a tunnel such as Cloudflare Tunnel or ngrok and set PUBLIC_BASE_URL to that HTTPS address instead of localhost."
    );
  }

  if (config.callProvider === "plivo") {
    return placePlivoCall(phoneNumber, answerUrl);
  }

  if (config.callProvider === "retell") {
    return placeRetellCall(phoneNumber, user);
  }

  return placeTwilioCall(phoneNumber, answerUrl);
}

function getCallProviderInput(body = {}) {
  return {
    digits: String(body.Digits || body.digits || "").trim(),
    speech: String(
      body.SpeechResult || body.Speech || body.speech || body.Transcription || ""
    ).trim()
  };
}

module.exports = {
  getCallProviderInput,
  hasPublicWebhookBaseUrl,
  isCallProviderConfigured,
  isPlivoConfigured,
  isRetellConfigured,
  isTwilioConfigured,
  placeOutboundCall
};
