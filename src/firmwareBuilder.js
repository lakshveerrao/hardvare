const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { config } = require("./config");

const execFileAsync = promisify(execFile);

function sanitizeFileStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

async function runArduinoCliCompile(sketchDir, outputDir) {
  const executablePath = resolveArduinoCliPath();
  const configPath = resolveArduinoCliConfigPath();

  try {
    const result = await execFileAsync(
      executablePath,
      [
        "--config-file",
        configPath,
        "compile",
        "--fqbn",
        config.otaArduinoFqbn,
        "--output-dir",
        outputDir,
        sketchDir
      ],
      {
        cwd: path.join(__dirname, ".."),
        maxBuffer: 10 * 1024 * 1024
      }
    );

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join("\n")
      .trim();

    throw new Error(output || "Arduino CLI could not compile the OTA firmware.");
  }
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
  const workspaceDir = path.join(config.otaBuildDir, sketchStem);
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
  const compileResult = await runArduinoCliCompile(workspaceDir, outputDir);
  const resolvedBinaryPath = await findAppBinary(outputDir, sketchStem);
  const binaryStats = await fsPromises.stat(resolvedBinaryPath);

  return {
    sourceFileName: sourceArtifact.fileName,
    sourceFilePath: sourceArtifact.filePath,
    appBinaryPath: resolvedBinaryPath,
    appBinaryFileName: path.basename(resolvedBinaryPath),
    outputDir,
    compiledAt: new Date(binaryStats.mtimeMs).toISOString(),
    reusedBinary: false,
    compileLog: [compileResult.stdout, compileResult.stderr].filter(Boolean).join("\n").trim()
  };
}

module.exports = {
  compileFirmwareForOta
};
