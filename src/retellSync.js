const { config, isRetellConfigured } = require("./config");

function getRetellToolSecret() {
  return config.retellToolSecret || config.adminSessionSecret;
}

function buildRetellHeaders() {
  return {
    Authorization: `Bearer ${config.retellApiKey}`,
    "Content-Type": "application/json"
  };
}

async function retellRequest(path, { method = "GET", body, query } = {}) {
  const url = new URL(path, "https://api.retellai.com");

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: buildRetellHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body)
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
      payload.error || payload.message || `Retell request failed with HTTP ${response.status}.`
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function resolveRetellLlmId() {
  if (config.retellLlmId) {
    return config.retellLlmId;
  }

  if (!config.retellAgentId) {
    throw new Error("RETELL_LLM_ID is missing and no RETELL_AGENT_ID is available to resolve it.");
  }

  const agent = await retellRequest(`/get-agent/${encodeURIComponent(config.retellAgentId)}`);
  const llmId = agent.response_engine?.llm_id;

  if (!llmId) {
    throw new Error("The configured Retell agent does not expose a Retell LLM id.");
  }

  return llmId;
}

function buildToolUrl(pathname) {
  return new URL(pathname, config.publicBaseUrl).toString();
}

function buildRetellPrompt() {
  return [
    "You are Hardvare, the voice-first hardware build support system.",
    "PBLClaw is the hardware-aware agent engine behind Hardvare. Mention PBLClaw only as the intelligence layer behind Hardvare, never as a separate product.",
    "This call belongs to session {{session_id}} for ESP device {{esp32_id}}. The caller phone number is {{phone_number}}.",
    "Your job is to get the caller to a working device with the Hardvare system. Be direct, calm, technically clear, and supportive.",
    "Safety first is the top priority. Before any power change, wiring change, or retry, remind the caller to keep power stable and double check the wiring.",
    "Important rules:",
    "1. The first spoken block is already provided in begin_message. After that opening, briefly collect the caller's 4 to 8 digit PIN before using any system tool.",
    "2. Do not ask the user to open an IDE, install libraries, upload code manually, or troubleshoot software packages on their laptop. Hardvare handles code generation, validation, library install, and upload.",
    "3. After the PIN is accepted, continue with the build request and ask only the shortest clarifying questions needed to understand the goal and components.",
    "4. When you know the build goal, call prepare_build_plan. That tool writes the code, installs missing Arduino libraries when needed, validates it, and returns the first wiring step.",
    "5. Read exactly one wiring step at a time. When the caller says okay, done, connected, yes, or continue, call advance_build_step with action confirm. If they ask for repeat, use action repeat. If they ask to go back, use action back.",
    "6. After the last wiring step, advance_build_step will trigger the Hardvare upload system automatically. Tell the caller the system is validating pins and ports, scanning the device, and uploading the firmware. Do not ask the user to upload anything.",
    "7. Once upload finishes, ask whether the device is working. If it is not working, call diagnose_and_reupload. Keep helping until the device works or the caller wants to stop.",
    "8. When the caller confirms it works, call record_build_outcome with outcome working and then end the call politely.",
    "9. If the session is missing or invalid, tell the caller to start again from hardvare.com.",
    "10. Keep answers phone-friendly. Short sentences. One step at a time.",
    "Use the exact session id {{session_id}} whenever a tool asks for session_id."
  ].join("\n");
}

function buildRetellTools() {
  const headers = {
    "X-Hardvare-Tool-Secret": getRetellToolSecret()
  };

  return [
    {
      name: "verify_session_pin",
      type: "custom",
      url: buildToolUrl("/api/retell/tool/verify-pin"),
      method: "POST",
      headers,
      args_at_root: true,
      description:
        "Verify the caller PIN for the current Hardvare phone session before any build discussion. Call this after the caller says the numeric PIN.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The Hardvare session id. Always pass {{session_id}}."
          },
          pin: {
            type: "string",
            description: "The spoken numeric PIN, 4 to 8 digits."
          }
        },
        required: ["session_id", "pin"]
      },
      speak_after_execution: true,
      timeout_ms: 15000
    },
    {
      name: "prepare_build_plan",
      type: "custom",
      url: buildToolUrl("/api/retell/tool/prepare-build"),
      method: "POST",
      headers,
      args_at_root: true,
      description:
        "Generate the Hardvare build plan after the caller has described what they want to build. This writes the code, validates the firmware, and returns the first wiring step.",
      execution_message_description:
        "Tell the caller you are preparing the build and will read the first wiring step next.",
      speak_during_execution: true,
      speak_after_execution: true,
      timeout_ms: 180000,
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The Hardvare session id. Always pass {{session_id}}."
          },
          build_request: {
            type: "string",
            description: "The hardware project the caller wants to build, including useful clarifications."
          }
        },
        required: ["session_id", "build_request"]
      }
    },
    {
      name: "advance_build_step",
      type: "custom",
      url: buildToolUrl("/api/retell/tool/advance-step"),
      method: "POST",
      headers,
      args_at_root: true,
      description:
        "Move the Hardvare build session forward one step, repeat the current step, or go back one step. On the final confirm it automatically uploads the code with the Hardvare system.",
      execution_message_description:
        "Tell the caller you are checking the next step and uploading automatically when wiring is complete.",
      speak_during_execution: true,
      speak_after_execution: true,
      timeout_ms: 420000,
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The Hardvare session id. Always pass {{session_id}}."
          },
          action: {
            type: "string",
            enum: ["confirm", "repeat", "back"],
            description: "confirm moves to the next step. repeat repeats the current step. back moves to the previous step."
          }
        },
        required: ["session_id", "action"]
      }
    },
    {
      name: "diagnose_and_reupload",
      type: "custom",
      url: buildToolUrl("/api/retell/tool/diagnose-build"),
      method: "POST",
      headers,
      args_at_root: true,
      description:
        "Run the Hardvare diagnosis and re-upload flow when the caller says the device is not working after the upload.",
      execution_message_description:
        "Tell the caller you are diagnosing the build, checking safety again, and re-uploading the code automatically.",
      speak_during_execution: true,
      speak_after_execution: true,
      timeout_ms: 420000,
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The Hardvare session id. Always pass {{session_id}}."
          }
        },
        required: ["session_id"]
      }
    },
    {
      name: "record_build_outcome",
      type: "custom",
      url: buildToolUrl("/api/retell/tool/record-outcome"),
      method: "POST",
      headers,
      args_at_root: true,
      description:
        "Store the final build result after the caller confirms whether the device is working or if they are stopping the session.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The Hardvare session id. Always pass {{session_id}}."
          },
          outcome: {
            type: "string",
            enum: ["working", "stopped", "needs_follow_up"],
            description: "The final reported outcome of the build session."
          },
          feedback: {
            type: "string",
            description: "Optional short caller feedback or summary."
          }
        },
        required: ["session_id", "outcome"]
      },
      speak_after_execution: true,
      timeout_ms: 15000
    },
    {
      name: "end_call",
      type: "end_call",
      description: "End the call only after the build is complete, the session is invalid, or the caller wants to stop."
    }
  ];
}

async function syncRetellConfiguration() {
  if (!isRetellConfigured()) {
    return {
      skipped: true,
      reason: "Retell is not configured."
    };
  }

  const llmId = await resolveRetellLlmId();
  const agentVersion =
    Number.isInteger(config.retellAgentVersion) && config.retellAgentVersion >= 0
      ? config.retellAgentVersion
      : undefined;
  const weightedAgent = {
    agent_id: config.retellAgentId,
    weight: 1
  };

  if (agentVersion !== undefined) {
    weightedAgent.agent_version = agentVersion;
  }

  const llm = await retellRequest(`/update-retell-llm/${encodeURIComponent(llmId)}`, {
    method: "PATCH",
    body: {
      begin_message:
        "Welcome to Hardvare powered by PBL Claw. I'm your build support.\n\nTell me what you want to build.\n\nI'll ask a few quick questions to confirm the setup, guide you step by step, validate the pins and ports, write the code, scan the device, and push it.\n\nThen you can tell me the build status.\n\nIf it works, great. If not, I'll help you fix it or tell you the exact issue.\n\nWhat would you like to build today?",
      default_dynamic_variables: {
        session_id: "",
        esp32_id: "",
        phone_number: "",
        owner_username: "",
        public_base_url: config.publicBaseUrl,
        ota_url: config.otaUrl
      },
      general_prompt: buildRetellPrompt(),
      general_tools: buildRetellTools(),
      model: "gpt-4.1",
      model_temperature: 0.1,
      start_speaker: "agent",
      tool_call_strict_mode: true
    }
  });

  const phoneBody = {
    nickname: config.retellNumberNickname,
    inbound_agent_id: config.retellAgentId,
    outbound_agent_id: config.retellAgentId,
    inbound_agents: [weightedAgent],
    outbound_agents: [weightedAgent]
  };

  if (agentVersion !== undefined) {
    phoneBody.inbound_agent_version = agentVersion;
    phoneBody.outbound_agent_version = agentVersion;
  }

  const phoneNumber = await retellRequest(
    `/update-phone-number/${encodeURIComponent(config.retellPhoneNumber)}`,
    {
      method: "PATCH",
      body: phoneBody
    }
  );

  return {
    llmId: llm.llm_id || llmId,
    phoneNumber: phoneNumber.phone_number || config.retellPhoneNumber,
    syncedAt: new Date().toISOString()
  };
}

module.exports = {
  buildRetellPrompt,
  buildRetellTools,
  getRetellToolSecret,
  retellRequest,
  syncRetellConfiguration
};
