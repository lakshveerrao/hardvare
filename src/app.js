const path = require("path");
const express = require("express");
const {
  authenticateCredentials,
  clearAuthSession,
  createAuthSession,
  getAuthSession
} = require("./adminAuth");
const { createBuildDraft, validateBuildDraft } = require("./buildService");
const {
  getCallProviderInput,
  isCallProviderConfigured,
  isPlivoConfigured,
  isRetellConfigured,
  isTwilioConfigured,
  placeOutboundCall
} = require("./callProvider");
const { BUILD_HINTS } = require("./content");
const { config, isOpenAIConfigured } = require("./config");
const { openOtaConsole } = require("./otaAutomation");
const { getRetellToolSecret } = require("./retellSync");
const {
  createAccount,
  createCallSession,
  getUser,
  getUserByDeviceId,
  incrementDeviceBuildCount,
  listUsers,
  setLastCallSid,
  updateUser,
  updateDeviceFeedback,
  verifyPin
} = require("./store");
const {
  isValidEspDeviceId,
  isValidPassword,
  isValidPhoneNumber,
  isValidPin,
  isValidUsername,
  normalizeEspDeviceId,
  normalizePassword,
  normalizePhoneNumber,
  normalizePin,
  normalizeUsername
} = require("./validation");
const { createVoiceResponse } = require("./voiceResponse");
const generationJobs = new Map();
const validationJobs = new Map();
const otaJobs = new Map();

function absoluteUrl(relativePath) {
  return new URL(relativePath, config.publicBaseUrl).toString();
}

function xmlResponse(res, voiceResponse) {
  res.type("text/xml");
  res.send(typeof voiceResponse === "string" ? voiceResponse : voiceResponse.toString());
}

function requireAuth(req, res, next) {
  const session = getAuthSession(req);

  if (!session) {
    return res.status(401).json({
      error: "Please sign in with a saved username and password."
    });
  }

  req.authSession = session;
  return next();
}

function canAccessSession(authSession, user) {
  return (
    authSession.role === "admin" ||
    (user.ownerAccountId && user.ownerAccountId === authSession.accountId)
  );
}

function shapeDashboardSession(user) {
  const artifact = user.buildPlan?.artifact || null;
  const diagnostics = user.otaStatus?.preflight?.diagnostics || null;
  const i2cScans = Array.isArray(diagnostics?.i2cScans) ? diagnostics.i2cScans : [];
  const i2cDeviceCount = i2cScans.reduce(
    (sum, scan) => sum + Number(scan?.deviceCount || 0),
    0
  );

  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    esp32Id: user.esp32Id || null,
    ownerUsername: user.ownerUsername || null,
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
    validationState: user.buildPlan?.validation?.state || null,
    validationAttempts: user.buildPlan?.validation?.attempts || 0,
    validatedAt: user.buildPlan?.validation?.validatedAt || null,
    artifact:
      artifact && {
        fileName: artifact.fileName,
        publicPath: artifact.publicPath,
        absoluteUrl: absoluteUrl(artifact.publicPath)
      },
    safetySummary: user.otaStatus?.preflight?.analysis?.spokenSummary || null,
    safetyState: user.otaStatus?.preflight?.analysis?.diagnosticState || null,
    recovery: user.otaStatus?.recovery || null,
    uploadMode: user.otaStatus?.uploadMode || null,
    firmwareFileName:
      user.otaStatus?.firmwareFileName ||
      user.buildPlan?.validation?.firmwareFileName ||
      null,
    diagnostics:
      diagnostics && {
        deviceId: diagnostics.deviceId || null,
        wifiConnected: Boolean(diagnostics?.wifi?.connected),
        wifiIp: diagnostics?.wifi?.ip || null,
        resetReason: diagnostics?.power?.resetReason || null,
        brownoutSuspected: Boolean(diagnostics?.power?.brownoutSuspected),
        freeHeap: Number(diagnostics?.freeHeap || 0),
        i2cDeviceCount,
        gpioCount: Array.isArray(diagnostics?.gpioSnapshot) ? diagnostics.gpioSnapshot.length : 0,
        warningCount: Array.isArray(diagnostics?.warnings) ? diagnostics.warnings.length : 0
      },
    otaStatus: user.otaStatus || null
  };
}

function shapeDashboardResponse(users, authSession) {
  const recentSessions = users.map(shapeDashboardSession);
  const providerConfigured = isCallProviderConfigured();

  return {
    account: {
      username: authSession.username,
      role: authSession.role
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
      callProvider: config.twilioMock ? "mock" : config.callProvider,
      callProviderConfigured: isCallProviderConfigured(),
      retellConfigured: isRetellConfigured(),
      twilioConfigured: isTwilioConfigured(),
      twilioMode: config.twilioMock ? "mock" : "live",
      plivoConfigured: isPlivoConfigured(),
      providerStatus: providerConfigured ? "configured" : "not configured",
      openaiConfigured: isOpenAIConfigured(),
      openaiMode: config.openaiMock ? "mock" : "live"
    },
    recentSessions
  };
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

function parseBuildOutcomeCommand(value) {
  const spokenValue = sanitizeSpeechValue(value).toLowerCase();

  if (!spokenValue) {
    return "unknown";
  }

  if (/\b(stop|cancel|end|hang up|goodbye)\b/.test(spokenValue)) {
    return "stop";
  }

  if (/\b(repeat|again|say again|once more)\b/.test(spokenValue)) {
    return "repeat";
  }

  if (/\b(retry|try again|reupload|fix it|not working|does not work|isn't working|failed|no)\b/.test(spokenValue)) {
    return "retry";
  }

  if (/\b(working|it works|works|yes|successful|done)\b/.test(spokenValue)) {
    return "working";
  }

  return "unknown";
}

function voiceRoutePatterns(endpoint) {
  return [`/voice/${endpoint}`, `/twilio/voice/${endpoint}`];
}

function invalidSessionResponse() {
  const response = createVoiceResponse();
  response.say("This call session is no longer valid. Please start again from the website.");
  response.hangup();
  return response;
}

function buildErrorResponse(message) {
  const response = createVoiceResponse();
  response.say(message);
  response.hangup();
  return response;
}

function pinPromptResponse(userId, attemptNumber) {
  const response = createVoiceResponse();
  response.say("Welcome to Hardware Builder. Please enter your PIN, then press the pound key.");

  const gather = response.gather({
    input: "dtmf",
    action: absoluteUrl(
      `/voice/verify-pin?userId=${encodeURIComponent(
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
  const response = createVoiceResponse();

  if (introText) {
    response.say(introText);
  }

  const gather = response.gather({
    input: "speech",
    action: absoluteUrl(`/voice/capture-build?userId=${encodeURIComponent(userId)}`),
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
  const response = createVoiceResponse();

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
    absoluteUrl(`/voice/build-status?userId=${encodeURIComponent(userId)}`)
  );

  return response;
}

function buildUploadProgressResponse(userId, introText) {
  const response = createVoiceResponse();

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
    absoluteUrl(`/voice/upload-status?userId=${encodeURIComponent(userId)}`)
  );

  return response;
}

function buildBuildConfirmationResponse(userId, introText, mode = "confirm") {
  const response = createVoiceResponse();

  if (introText) {
    response.say(introText);
  }

  const gather = response.gather({
    input: "speech",
    action: absoluteUrl(`/voice/confirm-build?userId=${encodeURIComponent(userId)}`),
    method: "POST",
    speechTimeout: "auto",
    language: "en-IN"
  });

  if (mode === "retry") {
    gather.say("After you correct the issue, say retry. You can also say stop.");
  } else {
    gather.say(
      "Please test it now. Say working if the build works, or say not working if you want automatic diagnosis and re-upload."
    );
  }

  response.say("I did not hear your answer. Goodbye.");
  response.hangup();

  return response;
}

function buildStepResponse(user, introText) {
  const response = createVoiceResponse();
  const currentStep = user.buildPlan.steps[user.currentStepIndex];

  if (!currentStep) {
    return buildUploadProgressResponse(
      user.id,
      introText || "The wiring steps are complete. Hardvare is moving to validation and upload."
    );
  }

  if (introText) {
    response.say(introText);
  }

  const gather = response.gather({
    input: "speech",
    action: absoluteUrl(`/voice/confirm-step?userId=${encodeURIComponent(user.id)}`),
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
    ownerUsername: user.ownerUsername || null,
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
        validation: user.buildPlan.validation || null,
        generatedAt: user.buildPlan.generatedAt || null
      },
    currentStepIndex: user.currentStepIndex || 0,
    otaStatus: user.otaStatus || null
  };
}

function currentBuildStep(user) {
  if (!user?.buildPlan?.steps?.length) {
    return null;
  }

  return user.buildPlan.steps[user.currentStepIndex] || null;
}

function buildStepPayload(user, message, state = "wiring") {
  const step = currentBuildStep(user);

  return {
    ok: true,
    state,
    message,
    projectTitle: user.buildPlan?.projectTitle || null,
    buildRequest: user.buildRequest || null,
    stepNumber: step ? (user.currentStepIndex || 0) + 1 : null,
    stepCount: user.buildPlan?.steps?.length || 0,
    stepTitle: step?.title || null,
    spokenInstruction: step?.spokenInstruction || null,
    firmwareFileName: user.buildPlan?.validation?.firmwareFileName || null,
    validationState: user.buildPlan?.validation?.state || null,
    validationAttempts: user.buildPlan?.validation?.attempts || 0
  };
}

function buildUploadPayload(user, message) {
  return {
    ok: true,
    state:
      user.otaStatus?.state === "failed"
        ? "needs_retry"
        : "awaiting_confirmation",
    message,
    projectTitle: user.buildPlan?.projectTitle || null,
    firmwareFileName:
      user.otaStatus?.firmwareFileName ||
      user.buildPlan?.validation?.firmwareFileName ||
      null,
    uploadMode: user.otaStatus?.uploadMode || null,
    otaState: user.otaStatus?.state || null,
    safetySummary: user.otaStatus?.preflight?.analysis?.spokenSummary || null,
    otaUrl: user.otaStatus?.url || config.otaUrl,
    recovery: user.otaStatus?.recovery || null
  };
}

function isRetellToolAuthorized(req) {
  const expectedSecret = getRetellToolSecret();

  if (!expectedSecret) {
    return true;
  }

  return req.get("X-Hardvare-Tool-Secret") === expectedSecret;
}

function extractRetellToolArgs(body = {}) {
  if (body && typeof body.args === "object" && body.args) {
    return body.args;
  }

  if (body && typeof body.arguments === "object" && body.arguments) {
    return body.arguments;
  }

  if (body && typeof body.tool_input === "object" && body.tool_input) {
    return body.tool_input;
  }

  return body;
}

function runTrackedJob(jobMap, key, factory) {
  if (jobMap.has(key)) {
    return jobMap.get(key);
  }

  const job = Promise.resolve()
    .then(factory)
    .finally(() => {
      jobMap.delete(key);
    });

  jobMap.set(key, job);
  return job;
}

async function generateBuildForUser(userId, buildRequest) {
  return runTrackedJob(generationJobs, userId, async () => {
    const user = await getUser(userId);

    if (!user) {
      return null;
    }

    await updateUser(userId, (draft) => {
      draft.buildRequest = buildRequest;
      draft.buildStatus = "generating";
      draft.buildError = null;
      draft.buildPlan = null;
      draft.currentStepIndex = 0;
      draft.otaStatus = null;
      return draft;
    });

    try {
      const buildPlan = await createBuildDraft({
        buildRequest,
        esp32Id: user.esp32Id
      });

      await updateUser(userId, (draft) => {
        draft.buildRequest = buildRequest;
        draft.buildStatus = "ready";
        draft.buildError = null;
        draft.buildPlan = buildPlan;
        draft.currentStepIndex = 0;
        draft.otaStatus = null;
        return draft;
      });
    } catch (error) {
      await updateUser(userId, (draft) => {
        draft.buildStatus = "failed";
        draft.buildError = error.message || "Build generation failed.";
        draft.buildPlan = null;
        draft.currentStepIndex = 0;
        return draft;
      });
      throw error;
    }

    startBuildValidation(userId);

    return getUser(userId);
  });
}

function startBuildGeneration(user, buildRequest) {
  generateBuildForUser(user.id, buildRequest).catch(() => {});
}

async function validateBuildForUser(userId) {
  return runTrackedJob(validationJobs, userId, async () => {
    const user = await getUser(userId);

    if (!user?.buildPlan) {
      return user;
    }

    if (user.buildPlan.validation?.state === "passed") {
      return user;
    }

    await updateUser(userId, (draft) => {
      if (!draft.buildPlan) {
        return draft;
      }

      draft.buildPlan.validation = {
        ...(draft.buildPlan.validation || {}),
        state: "running",
        error: null
      };
      return draft;
    });

    try {
      const validatedPlan = await validateBuildDraft({
        buildRequest: user.buildRequest || user.buildPlan.projectTitle || "hardware project",
        esp32Id: user.esp32Id,
        plan: user.buildPlan
      });

      await updateUser(userId, (draft) => {
        draft.buildStatus = "ready";
        draft.buildError = null;
        draft.buildPlan = validatedPlan;
        return draft;
      });
    } catch (error) {
      await updateUser(userId, (draft) => {
        if (!draft.buildPlan) {
          return draft;
        }

        draft.buildStatus = "ready";
        draft.buildError = error.message || "Build validation failed.";
        draft.buildPlan.validation = {
          ...(draft.buildPlan.validation || {}),
          state: "failed",
          validatedAt: new Date().toISOString(),
          error: error.message || "Build validation failed.",
          compileLog: error.compileLog || error.message || ""
        };
        return draft;
      });
      throw error;
    }

    return getUser(userId);
  });
}

function startBuildValidation(userId) {
  validateBuildForUser(userId).catch(() => {});
}

async function ensureValidatedBuildForUser(userId) {
  try {
    return await validateBuildForUser(userId);
  } catch {
    return getUser(userId);
  }
}

async function runOtaForUser(userId, runMode = "initial") {
  return runTrackedJob(otaJobs, userId, async () => {
    const user = await ensureValidatedBuildForUser(userId);

    if (!user) {
      return null;
    }

    if (!user.buildPlan?.artifact) {
      throw new Error("No validated firmware is available for this build session.");
    }

    if (user.buildPlan.validation?.state !== "passed") {
      throw new Error(
        user.buildPlan.validation?.error ||
          user.buildError ||
          "The firmware is not validated yet, so Hardvare cannot upload it."
      );
    }

    await updateUser(userId, (draft) => {
      draft.otaStatus = {
        state: "opening",
        runMode,
        requestedAt: new Date().toISOString(),
        previousResult: runMode === "recovery" ? draft.otaStatus || null : null
      };
      return draft;
    });

    try {
      const otaStatus = await openOtaConsole({
        esp32Id: user.esp32Id,
        artifact: user.buildPlan?.artifact || null,
        runMode
      });

      await updateUser(userId, (draft) => {
        draft.otaStatus = {
          state: "uploaded",
          ...otaStatus
        };
        return draft;
      });
    } catch (error) {
      await updateUser(userId, (draft) => {
        draft.otaStatus = {
          state: "failed",
          failedAt: new Date().toISOString(),
          runMode,
          error: error.message,
          preflight: error.preflight || draft.otaStatus?.preflight || null
        };
        return draft;
      });
      throw error;
    }

    return getUser(userId);
  });
}

function startOtaAutomation(user, runMode = "initial") {
  runOtaForUser(user.id, runMode).catch(() => {});
}

async function verifySessionPin(userId, pin) {
  const user = await getUser(userId);

  if (!user) {
    return {
      ok: false,
      state: "invalid_session",
      message: "This Hardvare session is no longer valid. Please start again from hardvare.com."
    };
  }

  const normalizedPin = normalizePin(pin);
  const attemptCount = Number(user.pinAttemptCount || 0);

  if (!isValidPin(normalizedPin) || !verifyPin(normalizedPin, user)) {
    const nextAttemptCount = attemptCount + 1;
    const attemptsRemaining = Math.max(0, config.maxPinAttempts - nextAttemptCount);

    await updateUser(userId, (draft) => {
      draft.pinAttemptCount = nextAttemptCount;
      draft.pinVerifiedAt = null;
      return draft;
    });

    return {
      ok: false,
      state: attemptsRemaining > 0 ? "pin_retry" : "pin_locked",
      attemptsRemaining,
      message:
        attemptsRemaining > 0
          ? `That PIN is not correct. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`
          : "That PIN is not correct and the session is locked. Please start again from hardvare.com."
    };
  }

  await updateUser(userId, (draft) => {
    draft.pinAttemptCount = 0;
    draft.pinVerifiedAt = new Date().toISOString();
    return draft;
  });

  return {
    ok: true,
    state: "pin_verified",
    attemptsRemaining: config.maxPinAttempts,
    message: "PIN accepted. Ask what they want to build on this ESP device."
  };
}

async function advanceBuildForUser(userId, action, { syncUpload = false } = {}) {
  const user = await getUser(userId);

  if (!user) {
    return {
      ok: false,
      state: "invalid_session",
      message: "This Hardvare session is no longer valid. Please start again from hardvare.com."
    };
  }

  if (!user.pinVerifiedAt) {
    return {
      ok: false,
      state: "pin_required",
      message: "Verify the PIN before continuing with the build."
    };
  }

  if (!user.buildPlan?.steps?.length) {
    return {
      ok: false,
      state: "build_missing",
      message: "No build plan is ready yet. Prepare the build plan before advancing steps."
    };
  }

  if (action === "repeat") {
    return buildStepPayload(user, "Repeat the current connection exactly as written.");
  }

  if (action === "back") {
    if ((user.currentStepIndex || 0) === 0) {
      return buildStepPayload(user, "You are already on the first connection.");
    }

    await updateUser(userId, (draft) => {
      draft.currentStepIndex = Math.max(0, (draft.currentStepIndex || 0) - 1);
      return draft;
    });

    return buildStepPayload(await getUser(userId), "Go back one connection.");
  }

  if (action !== "confirm") {
    return {
      ok: false,
      state: "invalid_action",
      message: "Use confirm, repeat, or back."
    };
  }

  const nextStepIndex = (user.currentStepIndex || 0) + 1;

  if (nextStepIndex < user.buildPlan.steps.length) {
    await updateUser(userId, (draft) => {
      draft.currentStepIndex = nextStepIndex;
      return draft;
    });

    return buildStepPayload(await getUser(userId), "Move to the next connection.");
  }

  if (!syncUpload) {
    await updateUser(userId, (draft) => {
      draft.currentStepIndex = user.buildPlan.steps.length;
      draft.otaStatus = {
        state: "opening",
        runMode: "initial",
        requestedAt: new Date().toISOString()
      };
      return draft;
    });

    startOtaAutomation(user, "initial");

    return {
      ok: true,
      state: "uploading",
      message:
        "All wiring is complete. Hardvare is scanning the board, validating the build, and uploading the code automatically now."
    };
  }

  await updateUser(userId, (draft) => {
    draft.currentStepIndex = user.buildPlan.steps.length;
    return draft;
  });

  try {
    const uploadedUser = await runOtaForUser(userId, "initial");
    return buildUploadPayload(
      uploadedUser,
      "The code has been generated, validated, and uploaded with the Hardvare system. Ask the caller whether the device is working."
    );
  } catch (error) {
    return buildUploadPayload(
      await getUser(userId),
      `The automatic upload needs attention. ${error.message || "Ask the caller if they want another diagnosis and re-upload."}`.trim()
    );
  }
}

async function diagnoseAndReupload(userId) {
  const user = await getUser(userId);

  if (!user) {
    return {
      ok: false,
      state: "invalid_session",
      message: "This Hardvare session is no longer valid. Please start again from hardvare.com."
    };
  }

  if (!user.buildPlan?.artifact) {
    return {
      ok: false,
      state: "build_missing",
      message: "No build plan is available to diagnose."
    };
  }

  try {
    const uploadedUser = await runOtaForUser(userId, "recovery");
    return buildUploadPayload(
      uploadedUser,
      "Hardvare finished the diagnosis and re-upload. Ask the caller to test the device again."
    );
  } catch (error) {
    return buildUploadPayload(
      await getUser(userId),
      `Hardvare ran the diagnosis and still needs attention. ${error.message || ""}`.trim()
    );
  }
}

async function recordBuildOutcome(userId, outcome, feedback = "") {
  const user = await getUser(userId);

  if (!user) {
    return {
      ok: false,
      state: "invalid_session",
      message: "This Hardvare session is no longer valid. Please start again from hardvare.com."
    };
  }

  await updateUser(userId, (draft) => {
    draft.buildOutcome = outcome;
    draft.buildOutcomeFeedback = String(feedback || "").trim();
    draft.buildOutcomeAt = new Date().toISOString();
    return draft;
  });

  if (user.devicePblId && outcome === "working") {
    await incrementDeviceBuildCount(user.devicePblId);
  }

  if (user.devicePblId && feedback) {
    await updateDeviceFeedback(user.devicePblId, feedback);
  }

  return {
    ok: true,
    state: outcome,
    message:
      outcome === "working"
        ? "Great. The working result is saved."
        : "The final session outcome is saved."
  };
}

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    if (
      req.path === "/" ||
      req.path === "/index.html" ||
      req.path === "/app.js" ||
      req.path === "/styles.css" ||
      req.path.startsWith("/api/")
    ) {
      res.set("Cache-Control", "no-store, max-age=0");
    }

    next();
  });
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use("/generated", express.static(path.join(__dirname, "..", "generated")));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      callProvider: config.twilioMock ? "mock" : config.callProvider,
      callProviderConfigured: isCallProviderConfigured(),
      retellConfigured: isRetellConfigured(),
      plivoConfigured: isPlivoConfigured(),
      twilioConfigured: isTwilioConfigured(),
      twilioMock: config.twilioMock,
      openaiConfigured: isOpenAIConfigured(),
      openaiMock: config.openaiMock
    });
  });

  function sendSessionResponse(req, res) {
    const session = getAuthSession(req);

    if (!session) {
      return res.json({
        authenticated: false
      });
    }

    return res.json({
      authenticated: true,
      username: session.username,
      role: session.role,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  }

  async function handleLogin(req, res, next) {
    try {
      const username = normalizeUsername(req.body.username);
      const password = normalizePassword(req.body.password);
      const account = await authenticateCredentials(username, password);

      if (!account) {
        return res.status(401).json({
          error: "Incorrect username or password."
        });
      }

      const session = createAuthSession(account);
      res.setHeader("Set-Cookie", session.cookie);

      return res.status(201).json({
        message: "Login successful.",
        username: account.username,
        role: account.role,
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    } catch (error) {
      return next(error);
    }
  }

  async function handleRegisterAccount(req, res, next) {
    try {
      const username = normalizeUsername(req.body.username);
      const password = normalizePassword(req.body.password);
      const confirmPassword = normalizePassword(
        req.body.confirmPassword || req.body.passwordConfirmation
      );

      if (!isValidUsername(username)) {
        return res.status(400).json({
          error: "Username must be 3 to 32 characters using letters, numbers, dots, underscores, or hyphens."
        });
      }

      if (!isValidPassword(password)) {
        return res.status(400).json({
          error: "Password must be 4 to 72 characters and cannot be blank."
        });
      }

      if (confirmPassword && password !== confirmPassword) {
        return res.status(400).json({
          error: "Password confirmation does not match."
        });
      }

      const account = await createAccount({
        username,
        password,
        role: "user"
      });
      const session = createAuthSession(account);
      res.setHeader("Set-Cookie", session.cookie);

      return res.status(201).json({
        message: "Account created and signed in successfully.",
        username: account.username,
        role: account.role,
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    } catch (error) {
      return next(error);
    }
  }

  function handleLogout(req, res) {
    res.setHeader("Set-Cookie", clearAuthSession(req));
    return res.json({
      message: "Logout successful."
    });
  }

  app.get(["/api/auth/session", "/api/admin/session"], sendSessionResponse);
  app.post(["/api/auth/login", "/api/admin/login"], handleLogin);
  app.post("/api/auth/register", handleRegisterAccount);
  app.post(["/api/auth/logout", "/api/admin/logout"], handleLogout);

  app.get(["/api/dashboard", "/api/admin/dashboard"], requireAuth, async (req, res, next) => {
    try {
      const users = await listUsers(25, {
        ownerAccountId: req.authSession.role === "admin" ? null : req.authSession.accountId
      });

      return res.json(shapeDashboardResponse(users, req.authSession));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/device/:esp32Id", requireAuth, async (req, res) => {
    const esp32Id = normalizeEspDeviceId(req.params.esp32Id);
    const user = await getUserByDeviceId(esp32Id);

    if (!user || !canAccessSession(req.authSession, user)) {
      return res.status(404).json({
        error: "No build session was found for that ESP32 ID."
      });
    }

    return res.json(shapeDeviceResponse(user));
  });

  app.post("/api/register", requireAuth, async (req, res, next) => {
    try {
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
      const pin = normalizePin(req.body.pin);
      const esp32Id = normalizeEspDeviceId(req.body.esp32Id);

      if (!isValidPhoneNumber(phoneNumber)) {
        return res.status(400).json({
          error:
            "Enter a phone number with at least 7 digits. Spaces, dashes, parentheses, and a leading plus sign are okay."
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

      const user = await createCallSession({
        phoneNumber,
        pin,
        esp32Id,
        ownerAccountId: req.authSession.accountId,
        ownerUsername: req.authSession.username
      });
      const call = await placeOutboundCall({
        phoneNumber: user.phoneNumber,
        answerUrl: absoluteUrl(`/voice/start?userId=${encodeURIComponent(user.id)}`),
        user
      });

      await setLastCallSid(user.id, call.sid);

      res.status(201).json({
        message:
          "Call started. Answer the phone, enter your PIN, and tell Hardware Builder what you want to build.",
        callSid: call.sid,
        provider: call.provider || (config.twilioMock ? "mock" : config.callProvider),
        mode: call.mock ? "mock" : "live",
        phoneNumber: user.phoneNumber,
        esp32Id: user.esp32Id,
        createdBy: req.authSession.username,
        voiceWebhook: call.url || absoluteUrl(`/voice/start?userId=${user.id}`)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/retell/tool/:toolName", async (req, res, next) => {
    try {
      if (!isRetellToolAuthorized(req)) {
        return res.status(401).json({
          ok: false,
          state: "unauthorized",
          message: "This Retell tool request is not authorized."
        });
      }

      const toolName = String(req.params.toolName || "").trim().toLowerCase();
      const args = extractRetellToolArgs(req.body);
      const sessionId = String(args.session_id || args.sessionId || "").trim();

      if (!sessionId) {
        return res.status(400).json({
          ok: false,
          state: "missing_session",
          message: "The Hardvare session id is required."
        });
      }

      if (toolName === "verify-pin") {
        return res.json(
          await verifySessionPin(sessionId, args.pin || args.user_pin || args.digits)
        );
      }

      if (toolName === "prepare-build") {
        const buildRequest = sanitizeSpeechValue(
          args.build_request || args.buildRequest || args.request
        );
        const user = await getUser(sessionId);

        if (!user) {
          return res.status(404).json({
            ok: false,
            state: "invalid_session",
            message: "This Hardvare session is no longer valid. Please start again from hardvare.com."
          });
        }

        if (!user.pinVerifiedAt) {
          return res.status(400).json({
            ok: false,
            state: "pin_required",
            message: "Verify the PIN before generating the build plan."
          });
        }

        if (!buildRequest) {
          return res.status(400).json({
            ok: false,
            state: "missing_build_request",
            message: "Describe what the caller wants to build before preparing the plan."
          });
        }

        try {
          const generatedUser = await generateBuildForUser(sessionId, buildRequest);
          return res.json(
            buildStepPayload(
              generatedUser,
              `Build plan ready for ${generatedUser.buildPlan.projectTitle}. Read the intro, then guide the caller through the first wiring step. Hardvare is validating the code in the background while the caller starts wiring.`,
              "wiring"
            )
          );
        } catch (error) {
          const failedUser = await getUser(sessionId);
          return res.json({
            ok: false,
            state: "build_failed",
            message: failedUser?.buildError || error.message || "Build generation failed."
          });
        }
      }

      if (toolName === "advance-step") {
        const action = String(args.action || "").trim().toLowerCase();
        return res.json(
          await advanceBuildForUser(sessionId, action, {
            syncUpload: true
          })
        );
      }

      if (toolName === "diagnose-build") {
        return res.json(await diagnoseAndReupload(sessionId));
      }

      if (toolName === "record-outcome") {
        return res.json(
          await recordBuildOutcome(
            sessionId,
            String(args.outcome || "").trim().toLowerCase(),
            sanitizeSpeechValue(args.feedback || "")
          )
        );
      }

      return res.status(404).json({
        ok: false,
        state: "unknown_tool",
        message: `Unknown Retell tool ${toolName}.`
      });
    } catch (error) {
      return next(error);
    }
  });

  app.all(voiceRoutePatterns("start"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const attempt = Number.parseInt(String(req.query.attempt || "1"), 10) || 1;

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    return xmlResponse(res, pinPromptResponse(user.id, attempt));
  });

  app.all(voiceRoutePatterns("verify-pin"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const attempt = Number.parseInt(String(req.query.attempt || "1"), 10) || 1;
    const enteredPin = normalizePin(getCallProviderInput(req.body).digits);

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (!isValidPin(enteredPin) || !verifyPin(enteredPin, user)) {
      const response = createVoiceResponse();

      if (attempt >= config.maxPinAttempts) {
        response.say("That PIN was not correct. You have used all allowed attempts. Goodbye.");
        response.hangup();
        return xmlResponse(res, response);
      }

      response.say("That PIN was not correct. Please try again.");
      response.redirect(
        { method: "POST" },
        absoluteUrl(
          `/voice/start?userId=${encodeURIComponent(user.id)}&attempt=${
            attempt + 1
          }`
        )
      );

      return xmlResponse(res, response);
    }

    return xmlResponse(res, buildRequestPromptResponse(user.id, "PIN accepted."));
  });

  app.all(voiceRoutePatterns("capture-build"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const providerInput = getCallProviderInput(req.body);
    const buildRequest = sanitizeSpeechValue(providerInput.speech || providerInput.digits);

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

  app.all(voiceRoutePatterns("build-status"), async (req, res) => {
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
        `I created a build plan for ${user.buildPlan.projectTitle}. ${user.buildPlan.spokenIntro}. Hardvare is validating the code while we start wiring. Let's begin with the first pin.`
      )
    );
  });

  app.all(voiceRoutePatterns("confirm-step"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const providerInput = getCallProviderInput(req.body);
    const command = parseStepCommand(providerInput.speech || providerInput.digits);

    if (!user || !user.buildPlan || !Array.isArray(user.buildPlan.steps)) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (command === "stop") {
      const response = createVoiceResponse();
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
        runMode: "initial",
        requestedAt: new Date().toISOString()
      };
      return draft;
    });

    startOtaAutomation(user, "initial");

    return xmlResponse(
      res,
      buildUploadProgressResponse(
        user.id,
        `Excellent. All wiring steps are complete. Safety first. I am scanning the hardware, validating the build, and uploading the code automatically for device ${user.esp32Id}. Please stay on the call.`
      )
    );
  });

  app.all(voiceRoutePatterns("upload-status"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (!user.otaStatus || ["opening"].includes(user.otaStatus.state)) {
      return xmlResponse(
        res,
        buildUploadProgressResponse(
          user.id,
          "I am still running the safety scan and OTA upload. Please stay on the call."
        )
      );
    }

    if (user.otaStatus.state === "failed") {
      const preflightSummary =
        user.otaStatus?.preflight?.analysis?.spokenSummary ||
        user.otaStatus?.preflight?.analysis?.criticalIssues?.join(" ") ||
        "";

      return xmlResponse(
        res,
        buildBuildConfirmationResponse(
          user.id,
          `Safety first. I paused the automatic upload. ${preflightSummary} ${user.otaStatus.error || ""}`.trim(),
          "retry"
        )
      );
    }

    const spokenSummary = user.otaStatus?.preflight?.analysis?.spokenSummary;
    const introText =
      user.otaStatus?.runMode === "recovery"
        ? `I finished automatic diagnosis and re-uploaded the code. ${spokenSummary || ""}`.trim()
        : `Safety scan complete and code uploaded automatically. ${spokenSummary || ""}`.trim();

    return xmlResponse(
      res,
      buildBuildConfirmationResponse(user.id, introText, "confirm")
    );
  });

  app.all(voiceRoutePatterns("confirm-build"), async (req, res) => {
    const user = await getUser(String(req.query.userId || ""));
    const providerInput = getCallProviderInput(req.body);
    const command = parseBuildOutcomeCommand(providerInput.speech || providerInput.digits);

    if (!user) {
      return xmlResponse(res, invalidSessionResponse());
    }

    if (command === "stop") {
      const response = createVoiceResponse();
      response.say("Okay. I am ending the call. Stay safe and double check power before the next test.");
      response.hangup();
      return xmlResponse(res, response);
    }

    if (command === "working") {
      const response = createVoiceResponse();
      response.say(
        "Great. The code is uploaded and your build is working. Safety first: keep power stable and check wiring before the next change. Goodbye."
      );
      response.hangup();
      return xmlResponse(res, response);
    }

    if (command === "retry") {
      await updateUser(user.id, (draft) => {
        draft.otaStatus = {
          state: "opening",
          runMode: "recovery",
          requestedAt: new Date().toISOString(),
          previousResult: draft.otaStatus || null
        };
        return draft;
      });

      const refreshedUser = await getUser(user.id);
      startOtaAutomation(refreshedUser, "recovery");

      return xmlResponse(
        res,
        buildUploadProgressResponse(
          user.id,
          "I am running automatic diagnosis, checking safety again, and re-uploading the code. Please stay on the call."
        )
      );
    }

    if (command === "repeat") {
      const mode = user.otaStatus?.state === "failed" ? "retry" : "confirm";
      const spokenSummary = user.otaStatus?.preflight?.analysis?.spokenSummary || "";
      const introText =
        mode === "retry"
          ? `Safety first. ${spokenSummary} ${user.otaStatus?.error || ""}`.trim()
          : `I uploaded the code. ${spokenSummary}`.trim();

      return xmlResponse(
        res,
        buildBuildConfirmationResponse(user.id, introText, mode)
      );
    }

    return xmlResponse(
      res,
      buildBuildConfirmationResponse(
        user.id,
        user.otaStatus?.state === "failed"
          ? "Say retry after you correct the issue, or say stop."
          : "Please say working or not working."
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
