const fs = require("fs/promises");
const path = require("path");
const OpenAI = require("openai");
const { config } = require("./config");
const { compileFirmwareForOta } = require("./firmwareBuilder");
const { BUILDER_SYSTEM_PROMPT, OTA_SCAFFOLD } = require("./content");

const MAX_VALIDATION_ATTEMPTS = 3;

function createOpenAIClient() {
  if (!config.openaiApiKey) {
    throw new Error(
      "OpenAI is not configured. Set OPENAI_API_KEY so the call can generate code and pin steps."
    );
  }

  return new OpenAI({
    apiKey: config.openaiApiKey
  });
}

function stripMarkdownFences(value) {
  return String(value || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(value) {
  const text = String(value || "");
  const startIndex = text.indexOf("{");
  const endIndex = text.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return text.trim();
  }

  return text.slice(startIndex, endIndex + 1).trim();
}

function sanitizeFileStem(value) {
  return String(value || "hardware-builder")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "hardware-builder";
}

function sanitizeGeneratedSketch(sketch) {
  let normalizedSketch = String(sketch || "");

  normalizedSketch = normalizedSketch.replace(
    /#include\s*<Servo\.h>/g,
    "#include <ESP32Servo.h>"
  );
  normalizedSketch = normalizedSketch.replace(
    /#include\s*<Esp32_SimpleDHT\.h>/g,
    "#include <SimpleDHT.h>"
  );
  normalizedSketch = normalizedSketch.replace(/\bBHT22\b/g, "DHT22");
  normalizedSketch = normalizedSketch.replace(/\bBHT11\b/g, "DHT11");
  normalizedSketch = normalizedSketch.replace(
    /^\s*(?:extern\s+)?(?:\"C\"\s+)?(?:bool|void)\s+ledcWrite\s*\([^;]*\);\s*$/gm,
    ""
  );
  normalizedSketch = normalizedSketch.replace(/\n{3,}/g, "\n\n");

  return normalizedSketch.trim() + "\n";
}

function validationErrorMessage(error) {
  return String(error?.message || error || "Unknown compile error.").trim();
}

async function repairPlanJson(client, { rawText, buildRequest, esp32Id }) {
  const response = await client.responses.create({
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: BUILDER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: [
          `ESP32 device ID: ${esp32Id}`,
          `Build request: ${buildRequest}`,
          "The previous answer was not valid JSON.",
          "Return only valid JSON in the required schema. Do not add any explanation.",
          "Previous answer:",
          rawText
        ].join("\n\n")
      }
    ]
  });

  return response.output_text;
}

function ensureValidPlan(plan, buildRequest, esp32Id) {
  if (!plan || typeof plan !== "object") {
    throw new Error("OpenAI returned an invalid build plan.");
  }

  const parts = Array.isArray(plan.parts) ? plan.parts.filter(Boolean) : [];
  const steps = Array.isArray(plan.steps)
    ? plan.steps
        .filter((step) => step && step.spokenInstruction)
        .map((step, index) => ({
          title: String(step.title || `Step ${index + 1}`).trim(),
          spokenInstruction: String(step.spokenInstruction || "").trim()
        }))
    : [];

  if (!steps.length) {
    throw new Error("OpenAI did not return any pin-by-pin steps.");
  }

  const sketch = String(plan.sketch || "").trim();

  if (!sketch) {
    throw new Error("OpenAI did not return any sketch code.");
  }

  return {
    projectTitle: String(plan.projectTitle || buildRequest).trim(),
    spokenIntro: String(
      plan.spokenIntro ||
        `I created an ESP32 build plan for ${buildRequest} on device ${esp32Id}.`
    ).trim(),
    parts,
    steps,
    sketchFileName: `${sanitizeFileStem(plan.sketchFileName || buildRequest)}.ino`,
    sketch: sanitizeGeneratedSketch(sketch)
  };
}

function buildMockPlan(buildRequest, esp32Id) {
  return ensureValidPlan(
    {
      projectTitle: `Mock builder plan for ${buildRequest}`,
      spokenIntro:
        "This is a mock OpenAI plan because OPENAI_MOCK is enabled. Replace it with a real OpenAI API key for live project generation.",
      parts: [
        "ESP32 dev board",
        "LED",
        "220 ohm resistor",
        "jumper wires"
      ],
      steps: [
        {
          title: "Ground wire",
          spokenInstruction: "Connect the LED cathode, the shorter leg, to a ground pin on the ESP32."
        },
        {
          title: "Signal pin",
          spokenInstruction:
            "Connect the LED anode through a 220 ohm resistor to GPIO 2 on the ESP32."
        }
      ],
      sketchFileName: `mock-${sanitizeFileStem(esp32Id)}.ino`,
      sketch: `${OTA_SCAFFOLD}\n\n// Mock project logic added by the local fallback.\nconst int ledPin = 2;\n\nvoid setupProject() {\n  pinMode(ledPin, OUTPUT);\n}\n\nvoid loopProject() {\n  digitalWrite(ledPin, HIGH);\n  delay(500);\n  digitalWrite(ledPin, LOW);\n  delay(500);\n}\n`
    },
    buildRequest,
    esp32Id
  );
}

async function writeSketchArtifact(plan, esp32Id) {
  await fs.mkdir(config.generatedDir, { recursive: true });
  const fileName = `${sanitizeFileStem(esp32Id)}-${sanitizeFileStem(plan.projectTitle)}.ino`;
  const filePath = path.join(config.generatedDir, fileName);

  await fs.writeFile(filePath, plan.sketch, "utf8");

  return {
    fileName,
    filePath,
    publicPath: `/generated/${encodeURIComponent(fileName)}`
  };
}

async function validatePlanArtifact(plan, esp32Id) {
  const artifact = await writeSketchArtifact(plan, esp32Id);
  const firmware = await compileFirmwareForOta({
    esp32Id,
    artifact
  });

  return {
    artifact,
    validation: {
      state: "passed",
      validatedAt: firmware.compiledAt,
      firmwareFileName: firmware.appBinaryFileName,
      firmwarePath: firmware.appBinaryPath,
      outputDir: firmware.outputDir,
      reusedBinary: firmware.reusedBinary,
      installedLibraries: firmware.installedLibraries || [],
      compileLog: firmware.compileLog || ""
    }
  };
}

function pendingValidationState() {
  return {
    state: "pending",
    attempts: 0,
    validatedAt: null,
    firmwareFileName: null,
    firmwarePath: null,
    outputDir: null,
    reusedBinary: false,
    installedLibraries: [],
    compileLog: "",
    error: null
  };
}

function normalizeExistingPlan(plan, buildRequest, esp32Id) {
  return ensureValidPlan(
    {
      projectTitle: plan?.projectTitle,
      spokenIntro: plan?.spokenIntro,
      parts: plan?.parts,
      steps: plan?.steps,
      sketchFileName: plan?.sketchFileName,
      sketch: plan?.sketch
    },
    buildRequest,
    esp32Id
  );
}

async function requestInitialPlan(client, { buildRequest, esp32Id }) {
  const response = await client.responses.create({
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: BUILDER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: [
          `ESP32 device ID: ${esp32Id}`,
          `Build request: ${buildRequest}`,
          "Use this OTA scaffold as the base of the final sketch:",
          OTA_SCAFFOLD
        ].join("\n\n")
      }
    ]
  });

  return parsePlanResponse(client, response.output_text, {
    buildRequest,
    esp32Id
  });
}

async function requestFixedPlan(client, { buildRequest, esp32Id, plan, compileError, attemptNumber }) {
  const repairPrompt = [
    `ESP32 device ID: ${esp32Id}`,
    `Original build request: ${buildRequest}`,
    `Validation attempt that failed: ${attemptNumber}`,
    "The previous JSON plan failed Arduino CLI compilation.",
    "Return the same JSON shape, but fix the sketch so it compiles for esp32:esp32:esp32s3.",
    "Preserve the OTA scaffold and keep the project safe.",
    "Current plan JSON:",
    JSON.stringify(
      {
        projectTitle: plan.projectTitle,
        spokenIntro: plan.spokenIntro,
        parts: plan.parts,
        steps: plan.steps,
        sketchFileName: plan.sketchFileName,
        sketch: plan.sketch
      },
      null,
      2
    ),
    "Arduino compile error output:",
    compileError
  ].join("\n\n");

  const response = await client.responses.create({
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: BUILDER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: repairPrompt
      }
    ]
  });

  return parsePlanResponse(client, response.output_text, {
    buildRequest,
    esp32Id
  });
}

async function parsePlanResponse(client, rawText, { buildRequest, esp32Id }) {
  const candidates = [
    stripMarkdownFences(rawText),
    extractJsonObject(stripMarkdownFences(rawText))
  ].filter(Boolean);
  let lastError = null;

  for (const candidate of [...new Set(candidates)]) {
    try {
      return ensureValidPlan(JSON.parse(candidate), buildRequest, esp32Id);
    } catch (error) {
      lastError = error;
    }
  }

  if (client && !config.openaiMock) {
    const repairedText = await repairPlanJson(client, {
      rawText,
      buildRequest,
      esp32Id
    });
    const repairedCandidates = [
      stripMarkdownFences(repairedText),
      extractJsonObject(stripMarkdownFences(repairedText))
    ].filter(Boolean);

    for (const candidate of [...new Set(repairedCandidates)]) {
      try {
        return ensureValidPlan(JSON.parse(candidate), buildRequest, esp32Id);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("OpenAI returned an invalid build plan.");
}

async function createBuildDraft({ buildRequest, esp32Id }) {
  const plan = config.openaiMock
    ? buildMockPlan(buildRequest, esp32Id)
    : await requestInitialPlan(createOpenAIClient(), {
        buildRequest,
        esp32Id
      });
  const artifact = await writeSketchArtifact(plan, esp32Id);

  return {
    ...plan,
    artifact,
    validation: pendingValidationState(),
    generatedAt: new Date().toISOString()
  };
}

async function validateBuildDraft({ buildRequest, esp32Id, plan }) {
  let workingPlan = normalizeExistingPlan(plan, buildRequest, esp32Id);
  let client = null;

  if (!config.openaiMock) {
    client = createOpenAIClient();
  }

  let lastValidationError = null;

  for (let attemptNumber = 1; attemptNumber <= MAX_VALIDATION_ATTEMPTS; attemptNumber += 1) {
    try {
      const { artifact, validation } = await validatePlanArtifact(workingPlan, esp32Id);

      return {
        ...workingPlan,
        artifact,
        validation: {
          ...validation,
          attempts: attemptNumber,
          error: null
        },
        generatedAt: plan?.generatedAt || new Date().toISOString()
      };
    } catch (error) {
      lastValidationError = error;

      if (!client || config.openaiMock || attemptNumber >= MAX_VALIDATION_ATTEMPTS) {
        break;
      }

      workingPlan = await requestFixedPlan(client, {
        buildRequest,
        esp32Id,
        plan: workingPlan,
        compileError: validationErrorMessage(error),
        attemptNumber
      });
    }
  }

  throw new Error(
    `Generated code could not be validated after ${MAX_VALIDATION_ATTEMPTS} attempts. ${validationErrorMessage(
      lastValidationError
    )}`
  );
}

async function generateBuildPlan({ buildRequest, esp32Id }) {
  const draftPlan = await createBuildDraft({
    buildRequest,
    esp32Id
  });

  return validateBuildDraft({
    buildRequest,
    esp32Id,
    plan: draftPlan
  });
}

module.exports = {
  createBuildDraft,
  generateBuildPlan,
  validateBuildDraft
};
