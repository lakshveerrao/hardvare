const path = require("path");
const express = require("express");
const twilio = require("twilio");
const {
  clearAdminSession,
  createAdminSession,
  getAdminSession,
  isValidAdminCredentials
} = require("./adminAuth");
const { generateBuildPlan } = require("./buildService");
const { BUILD_HINTS } = require("./content");
const { config, isOpenAIConfigured, isTwilioConfigured } = require("./config");
const { openOtaConsole } = require("./otaAutomation");
const {
  getUser,
  getUserByDeviceId,
  listUsers,
  setLastCallSid,
  updateUser,
  upsertUser,
  verifyPin
} = require("./store");
const {
  isValidEspDeviceId,
  isValidPhoneNumber,
  isValidPin,
  normalizeEspDeviceId,
  normalizePhoneNumber,
  normalizePin
} = require("./validation");

const VoiceResponse = twilio.twiml.VoiceResponse;
const generationJobs = new Map();
const otaJobs = new Map();

function absoluteUrl(relativePath) {
  return new URL(relativePath, config.publicBaseUrl).toString();
}

function xmlResponse(res, voiceResponse) {
  res.type("text/xml");
  res.send(voiceResponse.toString());
}

function hasPublicWebhookBaseUrl() {
  try {
    const url = new URL(config.publicBaseUrl);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    return !localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function isIndianPhoneNumber(phoneNumber) {
  return String(phoneNumber || "").startsWith("+91");
}

function createTwilioClient() {
  if (config.twilioApiKeySid && config.twilioApiKeySecret) {
    return twilio(config.twilioApiKeySid, config.twilioApiKeySecret, {
      accountSid: config.twilioAccountSid
    });
  }

  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

function requireAdmin(req, res, next) {
  const session = getAdminSession(req);

  if (!session) {
    return res.status(401).json({
      error: "Please sign in with the admin username and password."
    });
  }

  req.adminSession = session;
  return next();
}

function shapeDashboardSession(user) {
  const artifact = user.buildPlan?.artifact || null;

  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    esp32Id: user.esp32Id || null,
    updatedAt: user.updatedAt,
    createdAt: user.createdAt,
    lastCallSid: user.lastCallSid || null,
    buildRequest: user.buildRequest || null,
    buildStatus: user.buildStatus || "idle",
    buildError: user.buildError || null,
    currentStepIndex: user.buildPlan ? user.currentStepIndex || 0 : 0,
    stepCount: user.buildPlan?.stepCount || 0,
    projectTitle: user.buildPlan?.projectTitle || null,
    generatedAt: user.buildPlan?.generatedAt || null,
    artifact:
      artifact && {
        fileName: artifact.fileName,
        publicPath: artifact.publicPath,
        absoluteUrl: absoluteUrl(artifact.publicPath)
      },
    otaStatus: user.otaStatus || null
  };
}

function shapeDashboardResponse(users) {
  const recentSessions = users.map(shapeDashboardSession);

  return {
    admin: {
      username: config.adminUsername
    },
    summary: {
      totalSessions: recentSessions.length,
      generatingBuilds: recentSessions.filter((session) => session.buildStatus === "generating")
        .length,
      readyBuilds: recentSessions.filter((session) => session.buildStatus === "ready").length,
      otaActive: recentSessions.filter((session) =>
        ["opening", "opened", "uploaded"].includes(session.otaStatus?.state)
      ).length
    },
    services: {
      publicBaseUrl: config.publicBaseUrl,
      otaUrl: config.otaUrl,
      twilioConfigured: isTwilioConfigured(),
      twilioMode: config.twilioMock ? "mock" : "live",
      openaiConfigured: isOpenAIConfigured(),
      openaiMode: config.openaiMock ? "mock" : "live"
    },
    recentSessions
  };
}

async function placeOutboundCall(userId, phoneNumber) {
  const url = absoluteUrl(`/twilio/voice/start?userId=${encodeURIComponent(userId)}`);

  if (config.twilioMock) {
    return {
      sid: `MOCK-${Date.now()}`,
      mock: true,
      url
    };
  }

  if (!isTwilioConfigured()) {
    throw new Error(
      "Twilio is not configured. Set Twilio credentials and TWILIO_PHONE_NUMBER, or enable TWILIO_MOCK=true."
    );
  }

  if (!hasPublicWebhookBaseUrl()) {
    throw new Error(
      "PUBLIC_BASE_URL must be a public URL that Twilio can reach. Start a tunnel such as ngrok or localtunnel and set PUBLIC_BASE_URL to that HTTPS address instead of localhost."
    );
  }

  if (isIndianPhoneNumber(phoneNumber) && isIndianPhoneNumber(config.twilioPhoneNumber)) {
    throw new Error(
      "Twilio cannot place outbound calls to India from an Indian caller ID. Set TWILIO_PHONE_NUMBER to a voice-capable international non-Indian Twilio number, then try again."
    );
  }

  const client = createTwilioClient();

  return client.calls.create({
    to: phoneNumber,
    from: config.twilioPhoneNumber,
    url,
    method: "POST"
  });
}

function sanitizeSpeechValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function parseStepCommand(value) {
  const spokenValue = sanitizeSpeechValue(value).toLowerCase();

  if (!spokenValue) {
    return "unknown";
  }

  if (/\b(stop|cancel|end|hang up|goodbye)\b/.test(spokenValue)) {
    return "stop";
  }

  if (/\b(back|previous|go back)\b/.test(spokenValue)) {
    return "back";
  }

  if (/\b(repeat|again|say again|once more)\b/.test(spokenValue)) {
    return "repeat";
  }

  if (/\b(ok|okay|done|connected|next|yes|continue|proceed|finished)\b/.test(spokenValue)) {
    return "confirm";
  }

  return "unknown";
}

function invalidSessionResponse() {
  const response = new VoiceResponse();
  response.say("This call session is no longer valid. Please start again from the website.");
  response.hangup();
  return response;
}

function buildErrorResponse(message) {
  const response = new VoiceResponse();
  response.say(message);
  response.hangup();
  return response;
}

function pinPromptResponse(userId, attemptNumber) {
  const response = new VoiceResponse();
  response.say("Welcome to Hardware Builder. Please enter your PIN, then press the pound key.");

  const gather = response.gather({
    input: "dtmf",
    action: absoluteUrl(
      `/twilio/voice/verify-pin?userId=${encodeURIComponent(
        userId
      )}&attempt=${attemptNumber}`
    ),
    method: "POST",
    finishOnKey: "#",
    timeout: 8
  });

  gather.say("Enter your PIN now.");

  response.say("We did not receive a PIN. Goodbye.");
  response.hangup();

  return response;
}

function buildRequestPromptResponse(userId, introText) {
  const response = new VoiceResponse();

  if (introText) {
    response.say(introText);
  }

  const gather = response.gather({
    input: "speech",
    action: absoluteUrl(`/twilio/voice/capture-build?userId=${encodeURIComponent(userId)}`),
    method: "POST",
    speechTimeout: "auto",
    language: "en-IN",
    hints: BUILD_HINTS
  });

  gather.say(
    "Welcome to Hardware Builder. What do you want to build today? For example, say build a line follower robot or build a sensor alarm."
  );

  response.say("I did not hear the build request. Goodbye.");
  response.hangup();

  return response;
}

function buildPlanningResponse(userId, introText) {
  const response = new VoiceResponse();

  if (introText) {
    response.say(introText);
  }

  response.pause({
    length: 3
  });

  response.redirect(
    {
      method: "POST"
    },
    absoluteUrl(`/twilio/voice/build-status?userId=${encodeURIComponent(userId)}`)
  );

  return response;
}

function buildStepResponse(user, introText) {
  const response = new VoiceResponse();
  const currentStep = user.buildPlan.steps[user.currentStepIndex];

  if (introText) {
    response.say(introText);
  }

  const gather = response.gather({
    input: "speech",
    action: absoluteUrl(`/twilio/voice/confirm-step?userId=${encodeURIComponent(user.id)}`),
    method: "POST",
    speechTimeout: "auto",
    language: "en-IN"
  });

  gather.say(
    `${currentStep.title}. ${currentStep.spokenInstruction}. When this connection is finished, say okay. You can also say repeat, back, or stop.`
  );

  response.say("I did not hear a confirmation. Goodbye.");
  response.hangup();

  return response;
}

function shapeDeviceResponse(user) {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    esp32Id: user.esp32Id,
    buildRequest: user.buildRequest || null,
    buildPlan:
      user.buildPlan && {
        projectTitle: user.buildPlan.projectTitle,
        spokenIntro: user.buildPlan.spokenIntro,
        parts: user.buildPlan.parts || [],
        steps: (user.buildPlan.steps || []).map((step, index) => ({
          index: index + 1,
          title: step.title,
          spokenInstruction: step.spokenInstruction
        })),
        artifact: user.buildPlan.artifact || null,
        generatedAt: user.buildPlan.generatedAt || null
      },
    currentStepIndex: user.currentStepIndex || 0,
    otaStatus: user.otaStatus || null
  };
}

function startBuildGeneration(user, buildRequest) {
  if (generationJobs.has(user.id)) {
    return;
  }

  const job = generateBuildPlan({
    buildRequest,
    esp32Id: user.esp32Id
  })
    .then(async (buildPlan) => {
      await updateUser(user.id, (draft) => {
        draft.buildRequest = buildRequest;
        draft.buildStatus = "ready";
        draft.buildError = null;
        draft.buildPlan = buildPlan;
        draft.currentStepIndex = 0;
        return draft;
      });
    })
    .catch(async (error) => {
      await updateUser(user.id, (draft) => {
        draft.buildStatus = "failed";
        draft.buildError = error.message || "Build generation failed.";
        draft.buildPlan = null;
        draft.currentStepIndex = 0;
        return draft;
      });
    })
    .finally(() => {
      generationJobs.delete(user.id);
    });

  generationJobs.set(user.id, job);
}

function startOtaAutomation(user) {
  if (otaJobs.has(user.id)) {
    return;
  }

  const job = openOtaConsole({
    esp32Id: user.esp32Id,
    artifact: user.buildPlan?.artifact || null
  })
    .then(async (otaStatus) => {
      await updateUser(user.id, (draft) => {
        draft.otaStatus = {
          state: "opened",
          ...otaStatus
        };
        return draft;
      });
    })
    .catch(async (error) => {
      await updateUser(user.id, (draft) => {
        draft.otaStatus = {
          state: "failed",
          failedAt: new Date().toISOString(),
          error: error.message
        };
        return draft;
      });
    })
    .finally(() => {
      otaJobs.delete(user.id);
    });

  otaJobs.set(user.id, job);
}

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use("/generated", express.static(path.join(__dirname, "..", "generated")));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      twilioConfigured: isTwilioConfigured(),
      twilioMock: config.twilioMock,
      openaiConfigured: isOpenAIConfigured(),
      openaiMock: config.openaiMock
    });
  });

  app.get("/api/admin/session", (req, res) => {
    const session = getAdminSession(req);

    if (!session) {
      return res.json({
        authenticated: false
      });
    }

    return res.json({
      authenticated: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  });

  app.post("/api/admin/login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!isValidAdminCredentials(username, password)) {
      return res.status(401).json({
        error: "Incorrect admin username or password."
      });
    }

    const session = createAdminSession();
    res.setHeader("Set-Cookie", session.cookie);

    return res.status(201).json({
      message: "Admin login successful.",
      username: config.adminUsername,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  });

  app.post("/api/admin/logout", (req, res) => {
    res.setHeader("Set-Cookie", clearAdminSession(req));
    return res.json({
      message: "Admin logout successful."
    });
  });

  app.get("/api/admin/dashboard", requireAdmin, async (_req, res, next) => {
    try {
      const users = await listUsers(25);
      return res.json(shapeDashboardResponse(users));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/device/:esp32Id", requireAdmin, async (req, res) => {
    const esp32Id = normalizeEspDeviceId(req.params.esp32Id);
    const user = await getUserByDeviceId(esp32Id);

    if (!user) {
      return res.status(404).json({
        error: "No build session was found for that ESP32 ID."
      });
    }

    return res.json(shapeDeviceResponse(user));
  });

  app.post("/api/register", requireAdmin, async (req, res, next) => {
    try {
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
      const pin = normalizePin(req.body.pin);
      const esp32Id = normalizeEspDeviceId(req.body.esp32Id);

      if (!isValidPhoneNumber(phoneNumber)) {
        return res.status(400).json({
          error:
            "Use an international phone number in E.164 format, for example +919876543210."
        });
      }

      if (!isValidPin(pin)) {
        return res.status(400).json({
          error: "PIN must contain 4 to 8 digits."
        });
      }

      if (!isValidEspDeviceId(esp32Id)) {
        return res.status(400).json({
          error: "ESP32 ID must be 4 to 64 characters using letters, numbers, or hyphens."
        });
      }

      if (!isOpenAIConfigured()) {
        throw new Error(
          "OpenAI is not configured. Set OPENAI_API_KEY to enable live code and pin generation, or set OPENAI_MOCK=true for testing."
        );
      }

      const user = await upsertUser({ phoneNumber, pin, esp32Id });
      const call = await placeOutboundCall(user.id, user.phoneNumber);

      await setLastCallSid(user.id, call.sid);

      res.status(201).json({
        message:
          "Call started. Answer the phone, enter your PIN, and tell Hardware Builder what you want to build.",
        callSid: call.sid,
        mode: call.mock ? "mock" : "live",
        phoneNumber: user.phoneNumber,
        esp32Id: user.esp32Id,
        voiceWebhook: call.url || absoluteUrl(`/twilio/voice/start?userId=${user.id}`)
      });
    } catch (error) {
      next(error);
    }
  });

  app.all("/twilio/voice/start", async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const attempt = Number.parseInt(String(req.query.attempt || "1"), 10) || 1;

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    return xmlResponse(res, pinPromptResponse(user.id, attempt));
  });

  app.all("/twilio/voice/verify-pin", async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const attempt = Number.parseInt(String(req.query.attempt || "1"), 10) || 1;
    const enteredPin = normalizePin(req.body.Digits);

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (!isValidPin(enteredPin) || !verifyPin(enteredPin, user)) {
      const response = new VoiceResponse();

      if (attempt >= config.maxPinAttempts) {
        response.say("That PIN was not correct. You have used all allowed attempts. Goodbye.");
        response.hangup();
        return xmlResponse(res, response);
      }

      response.say("That PIN was not correct. Please try again.");
      response.redirect(
        { method: "POST" },
        absoluteUrl(
          `/twilio/voice/start?userId=${encodeURIComponent(user.id)}&attempt=${
            attempt + 1
          }`
        )
      );

      return xmlResponse(res, response);
    }

    return xmlResponse(res, buildRequestPromptResponse(user.id, "PIN accepted."));
  });

  app.all("/twilio/voice/capture-build", async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const buildRequest = sanitizeSpeechValue(req.body.SpeechResult || req.body.Digits);

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (!buildRequest) {
      return xmlResponse(
        res,
        buildRequestPromptResponse(user.id, "I did not catch that build request.")
      );
    }

    await updateUser(user.id, (draft) => {
      draft.buildRequest = buildRequest;
      draft.buildStatus = "generating";
      draft.buildError = null;
      draft.buildPlan = null;
      draft.currentStepIndex = 0;
      draft.otaStatus = null;
      return draft;
    });

    startBuildGeneration(user, buildRequest);

    return xmlResponse(
      res,
      buildPlanningResponse(
        user.id,
        `I heard your request for ${buildRequest}. Give me a moment while I prepare the code and the wiring plan.`
      )
    );
  });

  app.all("/twilio/voice/build-status", async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (user.buildStatus === "failed") {
      return xmlResponse(
        res,
        buildRequestPromptResponse(
          user.id,
          `I could not generate the build plan. ${user.buildError || "Please try again."}`
        )
      );
    }

    if (user.buildStatus !== "ready" || !user.buildPlan) {
      return xmlResponse(
        res,
        buildPlanningResponse(
          user.id,
          "I am still preparing the build. Please stay on the call."
        )
      );
    }

    return xmlResponse(
      res,
      buildStepResponse(
        user,
        `I created a build plan for ${user.buildPlan.projectTitle}. ${user.buildPlan.spokenIntro}. I also saved the code for your device ${user.esp32Id}. Let's start wiring with the first pin.`
      )
    );
  });

  app.all("/twilio/voice/confirm-step", async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const command = parseStepCommand(req.body.SpeechResult || req.body.Digits);

    if (!user || !user.buildPlan || !Array.isArray(user.buildPlan.steps)) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (command === "stop") {
      const response = new VoiceResponse();
      response.say("Okay. I am ending the call. Goodbye.");
      response.hangup();
      return xmlResponse(res, response);
    }

    if (command === "repeat") {
      return xmlResponse(
        res,
        buildStepResponse(user, "Sure. I will repeat the same connection.")
      );
    }

    if (command === "back") {
      if (user.currentStepIndex === 0) {
        return xmlResponse(
          res,
          buildStepResponse(user, "You are already on the first connection.")
        );
      }

      await updateUser(user.id, (draft) => {
        draft.currentStepIndex = Math.max(0, draft.currentStepIndex - 1);
        return draft;
      });

      const refreshedUser = await getUser(user.id);

      return xmlResponse(
        res,
        buildStepResponse(refreshedUser, "Going back one step.")
      );
    }

    if (command !== "confirm") {
      return xmlResponse(
        res,
        buildStepResponse(
          user,
          "Please answer like a normal call and say okay, repeat, back, or stop."
        )
      );
    }

    const nextStepIndex = user.currentStepIndex + 1;

    if (nextStepIndex < user.buildPlan.steps.length) {
      await updateUser(user.id, (draft) => {
        draft.currentStepIndex = nextStepIndex;
        return draft;
      });

      const refreshedUser = await getUser(user.id);

      return xmlResponse(
        res,
        buildStepResponse(refreshedUser, "Great. Here is the next connection.")
      );
    }

    await updateUser(user.id, (draft) => {
      draft.currentStepIndex = user.buildPlan.steps.length;
      draft.otaStatus = {
        state: "opening",
        requestedAt: new Date().toISOString()
      };
      return draft;
    });

    startOtaAutomation(user);

    return xmlResponse(
      res,
      buildErrorResponse(
        `Excellent. All wiring steps are complete. I am opening Chrome, signing in to the OTA page, and uploading the code for device ${user.esp32Id}. Goodbye.`
      )
    );
  });

  app.use((err, _req, res, _next) => {
    const statusCode = err.statusCode || 500;
    const errorBody = {
      error: err.message || "Unexpected server error."
    };

    if (err.code) {
      errorBody.twilioCode = err.code;
    }

    if (err.moreInfo) {
      errorBody.moreInfo = err.moreInfo;
    }

    res.status(statusCode).json({
      ...errorBody
    });
  });

  return app;
}

module.exports = {
  createApp
};
