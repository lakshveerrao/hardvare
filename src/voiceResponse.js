const { config } = require("./config");

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

class XmlNode {
  constructor(name, attributes = {}, text = "") {
    this.name = name;
    this.attributes = Object.entries(attributes).reduce((result, [key, value]) => {
      if (value === undefined || value === null || value === "") {
        return result;
      }

      result[key] = value;
      return result;
    }, {});
    this.text = text;
    this.children = [];
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

function renderXmlNode(node) {
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${xmlEscape(value)}"`)
    .join("");
  const renderedChildren = node.children.map(renderXmlNode).join("");
  const renderedText = node.text ? xmlEscape(node.text) : "";

  if (!renderedChildren && !renderedText) {
    return `<${node.name}${attributes}/>`;
  }

  return `<${node.name}${attributes}>${renderedText}${renderedChildren}</${node.name}>`;
}

function isPlivoProvider() {
  return config.callProvider === "plivo";
}

function createSpeakNode(text) {
  return new XmlNode(isPlivoProvider() ? "Speak" : "Say", {}, text);
}

function createPauseNode(length) {
  return new XmlNode(isPlivoProvider() ? "Wait" : "Pause", { length });
}

function createGatherNode(options) {
  if (isPlivoProvider()) {
    return new XmlNode("GetInput", {
      action: options.action,
      method: options.method || "POST",
      inputType: options.input,
      finishOnKey: options.finishOnKey,
      executionTimeout:
        Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
          ? Number(options.timeout)
          : undefined,
      speechEndTimeout:
        options.speechTimeout && options.speechTimeout !== "auto" ? options.speechTimeout : undefined,
      language: options.language,
      hints: options.hints,
      redirect: "true",
      speechModel: options.input === "speech" ? "phone_call" : undefined
    });
  }

  return new XmlNode("Gather", {
    input: options.input,
    action: options.action,
    method: options.method || "POST",
    finishOnKey: options.finishOnKey,
    timeout: options.timeout,
    speechTimeout: options.speechTimeout,
    language: options.language,
    hints: options.hints
  });
}

class GatherResponse {
  constructor(node) {
    this.node = node;
  }

  say(text) {
    this.node.appendChild(createSpeakNode(text));
    return this;
  }
}

class VoiceResponse {
  constructor() {
    this.root = new XmlNode("Response");
  }

  say(text) {
    this.root.appendChild(createSpeakNode(text));
    return this;
  }

  gather(options) {
    const node = createGatherNode(options);
    this.root.appendChild(node);
    return new GatherResponse(node);
  }

  redirect(options, url) {
    this.root.appendChild(
      new XmlNode("Redirect", { method: options?.method || "POST" }, url)
    );
    return this;
  }

  pause(options = {}) {
    this.root.appendChild(createPauseNode(options.length || 1));
    return this;
  }

  hangup() {
    this.root.appendChild(new XmlNode("Hangup"));
    return this;
  }

  toString() {
    return `<?xml version="1.0" encoding="UTF-8"?>${renderXmlNode(this.root)}`;
  }
}

function createVoiceResponse() {
  return new VoiceResponse();
}

module.exports = {
  createVoiceResponse,
  isPlivoProvider
};
