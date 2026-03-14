const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { config } = require("./config");

const execFileAsync = promisify(execFile);
const MAX_AUTO_LIBRARY_ROUNDS = 5;
const HEADER_LIBRARY_ALIASES = {
  "adafruit-neopixel.h": ["Adafruit NeoPixel"],
  "arduinojson.h": ["ArduinoJson"],
  "dht.h": ["DHT sensor library"],
  "esp32_simpledht.h": ["SimpleDHT"],
  "esp32servo.h": ["ESP32Servo"],
  "simpledht.h": ["SimpleDHT"]
};

function sanitizeFileStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildProfileSuffix() {
  const raw = sanitizeFileStem(config.otaArduinoBoardOptions || "default");
  return raw || "default";
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function resolveArduinoCliPath() {
  if (!fileExists(config.arduinoCliPath)) {
    throw new Error(
      `Arduino CLI was not found at ${config.arduinoCliPath}. Install it or set ARDUINO_CLI_PATH.`
    );
  }

  return config.arduinoCliPath;
}

function resolveArduinoCliConfigPath() {
  if (!fileExists(config.arduinoCliConfigPath)) {
    throw new Error(
      `Arduino CLI config was not found at ${config.arduinoCliConfigPath}. Set ARDUINO_CLI_CONFIG_PATH to the correct file.`
    );
  }

  return config.arduinoCliConfigPath;
}

async function findLatestSourceArtifact(esp32Id) {
  const generatedEntries = await fsPromises.readdir(config.generatedDir, {
    withFileTypes: true
  });
  const devicePrefix = `${sanitizeFileStem(esp32Id)}-`;
  const candidates = [];

  for (const entry of generatedEntries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".ino") {
      continue;
    }

    if (!entry.name.toLowerCase().startsWith(devicePrefix)) {
      continue;
    }

    const absolutePath = path.join(config.generatedDir, entry.name);
    const stats = await fsPromises.stat(absolutePath);

    candidates.push({
      fileName: entry.name,
      filePath: absolutePath,
      modifiedAt: stats.mtimeMs
    });
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);

  return candidates[0] || null;
}

async function resolveSourceArtifact({ esp32Id, artifact }) {
  if (artifact?.filePath && fileExists(artifact.filePath)) {
    return {
      fileName: artifact.fileName || path.basename(artifact.filePath),
      filePath: artifact.filePath
    };
  }

  const fallbackArtifact = await findLatestSourceArtifact(esp32Id);

  if (fallbackArtifact) {
    return fallbackArtifact;
  }

  throw new Error(
    `No generated sketch was found for device ${esp32Id}. Generate the code before starting OTA upload.`
  );
}

async function runArduinoCliCommand(commandArgs, options = {}) {
  const executablePath = resolveArduinoCliPath();
  const configPath = resolveArduinoCliConfigPath();
  const result = await execFileAsync(
    executablePath,
    [
      "--config-file",
      configPath,
      ...commandArgs
    ],
    {
      cwd: path.join(__dirname, ".."),
      maxBuffer: 10 * 1024 * 1024,
      ...options
    }
  );

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function runArduinoCliCompile(sketchDir, outputDir) {
  const commandArgs = [
    "compile",
    "--fqbn",
    config.otaArduinoFqbn,
    "--output-dir",
    outputDir
  ];

  if (config.otaArduinoBoardOptions) {
    commandArgs.push("--board-options", config.otaArduinoBoardOptions);
  }

  commandArgs.push(sketchDir);

  try {
    const result = await runArduinoCliCommand(commandArgs);

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      ok: true
    };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    const wrappedError = new Error(output || "Arduino CLI could not compile the OTA firmware.");
    wrappedError.compileLog = output;
    wrappedError.stdout = error.stdout || "";
    wrappedError.stderr = error.stderr || "";
    throw wrappedError;
  }
}

async function runArduinoCliBoardList() {
  try {
    const result = await runArduinoCliCommand([
      "board",
      "list",
      "--format",
      "json"
    ]);

    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join("\n")
      .trim();

    throw new Error(output || "Arduino CLI could not list connected boards.");
  }
}

function comparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function currentArchitecture() {
  const [, architecture] = String(config.otaArduinoFqbn || "").split(":");
  return String(architecture || "").toLowerCase();
}

function parseMissingHeaders(compileLog) {
  const text = String(compileLog || "");
  const headers = new Set();
  const patterns = [
    /fatal error:\s*([^\s:]+\.(?:h|hpp)):\s*No such file or directory/gi,
    /Compilation error:\s*([^\s:]+\.(?:h|hpp)):\s*No such file or directory/gi,
    /Alternatives for\s+([^\s:]+\.(?:h|hpp)):\s*\[\]/gi
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);

    while (match) {
      headers.add(match[1].trim());
      match = pattern.exec(text);
    }
  }

  return [...headers];
}

function scoreLibraryCandidate(library, headerName) {
  const latest = library?.latest || {};
  const includes = Array.isArray(latest.provides_includes) ? latest.provides_includes : [];
  const comparableHeader = comparableText(headerName);
  const comparableHeaderBase = comparableText(path.basename(headerName));
  const comparableLibraryName = comparableText(library?.name);
  const comparableLatestName = comparableText(latest.name || library?.name);
  const architectures = Array.isArray(latest.architectures)
    ? latest.architectures.map((entry) => String(entry || "").toLowerCase())
    : [];
  const targetArchitecture = currentArchitecture();
  let score = 0;

  for (const includeEntry of includes) {
    const comparableInclude = comparableText(includeEntry);
    const comparableIncludeBase = comparableText(path.basename(includeEntry));

    if (comparableInclude === comparableHeader || comparableIncludeBase === comparableHeader) {
      score += 120;
    } else if (
      comparableInclude === comparableHeaderBase ||
      comparableIncludeBase === comparableHeaderBase
    ) {
      score += 100;
    }
  }

  if (comparableLibraryName === comparableHeaderBase || comparableLatestName === comparableHeaderBase) {
    score += 40;
  }

  if (
    comparableLibraryName.includes(comparableHeaderBase) ||
    comparableLatestName.includes(comparableHeaderBase)
  ) {
    score += 20;
  }

  if (architectures.includes(targetArchitecture)) {
    score += 25;
  } else if (architectures.includes("*")) {
    score += 10;
  }

  return score;
}

async function searchArduinoLibrariesByHeader(headerName) {
  try {
    const result = await runArduinoCliCommand([
      "lib",
      "search",
      `provides:${headerName}`,
      "--format",
      "json",
      "--omit-releases-details"
    ]);
    const payload = JSON.parse(result.stdout || "{}");
    return Array.isArray(payload.libraries) ? payload.libraries : [];
  } catch {
    return [];
  }
}

async function searchArduinoLibraries(query) {
  try {
    const result = await runArduinoCliCommand([
      "lib",
      "search",
      query,
      "--format",
      "json",
      "--omit-releases-details"
    ]);
    const payload = JSON.parse(result.stdout || "{}");
    return Array.isArray(payload.libraries) ? payload.libraries : [];
  } catch {
    return [];
  }
}

async function resolveLibraryCandidate(headerName) {
  const aliasNames =
    HEADER_LIBRARY_ALIASES[String(path.basename(headerName || "")).toLowerCase()] || [];

  if (aliasNames.length) {
    return {
      headerName,
      libraryName: aliasNames[0],
      version: "",
      score: 1000
    };
  }

  const headerBaseName = path.parse(path.basename(headerName || "")).name;
  const variants = [
    headerName,
    path.basename(headerName),
    headerBaseName,
    headerBaseName.replace(/[_-]+/g, " ")
  ].filter(Boolean);
  const candidates = [];

  for (const variant of [...new Set(variants)]) {
    const libraries = [
      ...(await searchArduinoLibrariesByHeader(variant)),
      ...(await searchArduinoLibraries(variant))
    ];

    for (const library of libraries) {
      candidates.push({
        headerName,
        libraryName: library?.name || "",
        version: library?.latest?.version || "",
        score: scoreLibraryCandidate(library, headerName)
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.libraryName.localeCompare(right.libraryName);
  });

  return candidates.find((candidate) => candidate.libraryName && candidate.score > 0) || null;
}

async function installArduinoLibrary(libraryName) {
  try {
    const result = await runArduinoCliCommand([
      "lib",
      "install",
      libraryName,
      "--no-overwrite"
    ]);

    return {
      libraryName,
      installLog: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    const wrappedError = new Error(
      output || `Arduino CLI could not install the required library ${libraryName}.`
    );
    wrappedError.installLog = output;
    throw wrappedError;
  }
}

async function compileWithAutoInstalledLibraries(sketchDir, outputDir) {
  const installedLibraries = [];
  const attemptedHeaders = new Set();
  const attemptedLibraries = new Set();
  let lastError = null;

  for (let round = 0; round <= MAX_AUTO_LIBRARY_ROUNDS; round += 1) {
    try {
      const compileResult = await runArduinoCliCompile(sketchDir, outputDir);
      return {
        compileResult,
        installedLibraries
      };
    } catch (error) {
      lastError = error;

      if (round >= MAX_AUTO_LIBRARY_ROUNDS) {
        throw error;
      }

      const missingHeaders = parseMissingHeaders(
        error.compileLog || error.stderr || error.message
      ).filter((headerName) => !attemptedHeaders.has(headerName));

      if (!missingHeaders.length) {
        throw error;
      }

      let installedAnyLibrary = false;

      for (const headerName of missingHeaders) {
        attemptedHeaders.add(headerName);
        const candidate = await resolveLibraryCandidate(headerName);

        if (!candidate || attemptedLibraries.has(candidate.libraryName)) {
          continue;
        }

        attemptedLibraries.add(candidate.libraryName);
        const installResult = await installArduinoLibrary(candidate.libraryName);
        installedLibraries.push({
          headerName,
          libraryName: candidate.libraryName,
          version: candidate.version || "",
          installLog: installResult.installLog
        });
        installedAnyLibrary = true;
      }

      if (!installedAnyLibrary) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Arduino CLI could not compile the OTA firmware.");
}

function scoreDetectedPort(entry) {
  const port = entry?.port || {};
  const properties = port.properties || {};
  const matchingBoards = Array.isArray(entry?.matching_boards)
    ? entry.matching_boards
    : [];
  const label = String(port.label || "").toLowerCase();
  const protocolLabel = String(port.protocol_label || "").toLowerCase();
  const vid = String(properties.vid || "").toLowerCase();
  const pid = String(properties.pid || "").toLowerCase();
  const matchingFqbns = matchingBoards.map((board) => String(board?.fqbn || "").toLowerCase());
  let score = 0;

  if (label.includes("bluetooth") || protocolLabel.includes("bluetooth")) {
    return -100;
  }

  if (!matchingBoards.length && !vid && !pid) {
    return 0;
  }

  if (matchingFqbns.some((fqbn) => fqbn.includes("esp32:esp32"))) {
    score += 40;
  }

  if (vid === "0x303a") {
    score += 30;
  }

  if (pid === "0x1001") {
    score += 20;
  }

  if (String(port.protocol || "").toLowerCase() === "serial") {
    score += 10;
  }

  return score;
}

async function listEspUploadTargets() {
  const boardList = await runArduinoCliBoardList();
  const detectedPorts = Array.isArray(boardList?.detected_ports)
    ? boardList.detected_ports
    : [];

  const candidates = detectedPorts
    .map((entry) => ({
      score: scoreDetectedPort(entry),
      address: entry?.port?.address || "",
      label: entry?.port?.label || "",
      protocol: entry?.port?.protocol || "",
      matchingBoards: Array.isArray(entry?.matching_boards) ? entry.matching_boards : [],
      properties: entry?.port?.properties || {}
    }))
    .filter((entry) => entry.address && entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!candidates.length) {
    throw new Error(
      "No ESP32 USB upload target was detected. Connect the board with USB for automatic recovery."
    );
  }

  return candidates;
}

async function findEspUploadTarget() {
  const candidates = await listEspUploadTargets();
  return candidates[0];
}

async function findAppBinary(outputDir, sketchStem) {
  const directPath = path.join(outputDir, `${sketchStem}.ino.bin`);

  if (fileExists(directPath)) {
    return directPath;
  }

  const entries = await fsPromises.readdir(outputDir, {
    withFileTypes: true
  });
  const binaryEntry = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ino.bin")
  );

  if (!binaryEntry) {
    throw new Error("Arduino CLI finished, but no OTA application binary was produced.");
  }

  return path.join(outputDir, binaryEntry.name);
}

async function compileFirmwareForOta({ esp32Id, artifact }) {
  const sourceArtifact = await resolveSourceArtifact({ esp32Id, artifact });
  const sketchStem = path.parse(sourceArtifact.fileName).name;
  const workspaceDir = path.join(config.otaBuildDir, buildProfileSuffix(), sketchStem);
  const sketchPath = path.join(workspaceDir, `${sketchStem}.ino`);
  const outputDir = path.join(workspaceDir, "output");
  const appBinaryPath = path.join(outputDir, `${sketchStem}.ino.bin`);
  const sourceStats = await fsPromises.stat(sourceArtifact.filePath);

  await fsPromises.mkdir(workspaceDir, {
    recursive: true
  });

  if (fileExists(appBinaryPath)) {
    const binaryStats = await fsPromises.stat(appBinaryPath);

    if (binaryStats.mtimeMs >= sourceStats.mtimeMs) {
      return {
        sourceFileName: sourceArtifact.fileName,
        sourceFilePath: sourceArtifact.filePath,
        appBinaryPath,
        appBinaryFileName: path.basename(appBinaryPath),
        sketchDir: workspaceDir,
        outputDir,
        compiledAt: new Date(binaryStats.mtimeMs).toISOString(),
        reusedBinary: true
      };
    }
  }

  await fsPromises.rm(outputDir, {
    recursive: true,
    force: true
  });
  await fsPromises.copyFile(sourceArtifact.filePath, sketchPath);

  let compileResult = {
    stdout: "",
    stderr: "",
    ok: true
  };
  let installedLibraries = [];
  let compileError = null;

  try {
    const compileResponse = await compileWithAutoInstalledLibraries(workspaceDir, outputDir);
    compileResult = compileResponse.compileResult;
    installedLibraries = compileResponse.installedLibraries;
  } catch (error) {
    compileError = error;
    compileResult = {
      stdout: error.stdout || "",
      stderr: error.stderr || error.compileLog || error.message || "",
      ok: false
    };
  }

  let resolvedBinaryPath = null;

  try {
    resolvedBinaryPath = await findAppBinary(outputDir, sketchStem);
  } catch {
    resolvedBinaryPath = null;
  }

  if (!resolvedBinaryPath) {
    throw compileError || new Error("Arduino CLI could not compile the OTA firmware.");
  }

  const binaryStats = await fsPromises.stat(resolvedBinaryPath);

  return {
    sourceFileName: sourceArtifact.fileName,
    sourceFilePath: sourceArtifact.filePath,
    appBinaryPath: resolvedBinaryPath,
    appBinaryFileName: path.basename(resolvedBinaryPath),
    sketchDir: workspaceDir,
    outputDir,
    compiledAt: new Date(binaryStats.mtimeMs).toISOString(),
    reusedBinary: false,
    compileRecoveredFromNonZeroExit: Boolean(compileError),
    compileLog: [compileResult.stdout, compileResult.stderr].filter(Boolean).join("\n").trim(),
    installedLibraries
  };
}

async function uploadFirmwareOverSerial(firmware) {
  const targets = await listEspUploadTargets();
  const uploadErrors = [];

  for (const target of targets) {
    const commandArgs = [
      "upload",
      "--fqbn",
      config.otaArduinoFqbn,
      "--build-path",
      firmware.outputDir,
      "--port",
      target.address,
      "--discovery-timeout",
      "10s",
      "--verify"
    ];

    if (config.otaArduinoBoardOptions) {
      commandArgs.push("--board-options", config.otaArduinoBoardOptions);
    }

    commandArgs.push(firmware.sketchDir);

    try {
      const result = await runArduinoCliCommand(commandArgs);

      return {
        responseText: "OK",
        uploadedAt: new Date().toISOString(),
        uploadMode: "serial-cli",
        portAddress: target.address,
        portLabel: target.label,
        portProtocol: target.protocol,
        portProperties: target.properties,
        uploadLog: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      };
    } catch (error) {
      const output = [error.stdout, error.stderr, error.message]
        .filter(Boolean)
        .join("\n")
        .trim();
      uploadErrors.push(`${target.address}: ${output || "USB upload failed."}`);
    }
  }

  throw new Error(uploadErrors.join("\n\n") || "Arduino CLI could not upload the firmware over USB.");
}

module.exports = {
  compileFirmwareForOta,
  findEspUploadTarget,
  listEspUploadTargets,
  uploadFirmwareOverSerial
};
