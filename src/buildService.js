const fs = require("fs/promises");
const path = require("path");
const OpenAI = require("openai");
const { config } = require("./config");
const { BUILDER_SYSTEM_PROMPT, OTA_SCAFFOLD } = require("./content");

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

function sanitizeFileStem(value) {
  return String(value || "hardware-builder")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "hardware-builder";
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
    sketch
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

async function generateBuildPlan({ buildRequest, esp32Id }) {
  let plan;

  if (config.openaiMock) {
    plan = buildMockPlan(buildRequest, esp32Id);
  } else {
    const client = createOpenAIClient();
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

    const responseText = stripMarkdownFences(response.output_text);
    plan = ensureValidPlan(JSON.parse(responseText), buildRequest, esp32Id);
  }

  const artifact = await writeSketchArtifact(plan, esp32Id);

  return {
    ...plan,
    artifact,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  generateBuildPlan
};
