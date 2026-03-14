const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const { config } = require("./config");
const {
  compileFirmwareForOta,
  findEspUploadTarget,
  uploadFirmwareOverSerial
} = require("./firmwareBuilder");
const { analyzeDiagnostics, writePreflightArtifact } = require("./preflightScanner");

const knownChromePaths = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
];

const activeBrowsers = new Set();
const subnetDiscoveryConcurrency = 24;

function resolveBrowserPath() {
  if (config.chromeExecutablePath && fs.existsSync(config.chromeExecutablePath)) {
    return config.chromeExecutablePath;
  }

  const detectedPath = knownChromePaths.find((candidate) => fs.existsSync(candidate));

  if (!detectedPath) {
    throw new Error(
      "Chrome or Edge was not found on this machine, so OTA login automation could not start."
    );
  }

  return detectedPath;
}

function isUpdateResponse(response) {
  try {
    const parsedUrl = new URL(response.url());
    return parsedUrl.pathname === "/update" && response.request().method() === "POST";
  } catch {
    return false;
  }
}

function isUpdateRequest(request) {
  try {
    const parsedUrl = new URL(request.url());
    return parsedUrl.pathname === "/update" && request.method() === "POST";
  } catch {
    return false;
  }
}

async function parseUploadResponse(response, uploadMode) {
  const responseText = String(await response.text()).trim();

  if (!response.ok() || responseText.toUpperCase() !== "OK") {
    throw new Error(
      `ESP OTA upload did not finish successfully. Device replied with: ${responseText || response.status()}.`
    );
  }

  return {
    responseText,
    uploadedAt: new Date().toISOString(),
    uploadMode
  };
}

function uploadFirmwareWithHttp(firmware, otaBaseUrl = config.otaUrl) {
  return new Promise((resolve, reject) => {
    const uploadUrl = new URL("/update", otaBaseUrl);
    const boundary = `----HardwareBuilder${Date.now().toString(16)}`;
    const fileBuffer = fs.readFileSync(firmware.appBinaryPath);
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="update"; filename="${firmware.appBinaryFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const requestBody = Buffer.concat([preamble, fileBuffer, epilogue]);
    const transport = uploadUrl.protocol === "https:" ? https : http;
    let responseStatusCode = 0;
    let responseText = "";

    const request = transport.request({
      protocol: uploadUrl.protocol,
      hostname: uploadUrl.hostname,
      port: uploadUrl.port || (uploadUrl.protocol === "https:" ? 443 : 80),
      path: `${uploadUrl.pathname}${uploadUrl.search}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": requestBody.length
      }
    }, (response) => {
      responseStatusCode = response.statusCode || 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseText += chunk;
      });
      response.on("end", () => {
        resolve({
          ok: responseStatusCode >= 200 && responseStatusCode < 300,
          statusCode: responseStatusCode,
          responseText: responseText.trim()
        });
      });
      response.on("error", (error) => {
        if (responseStatusCode >= 200 && responseStatusCode < 300) {
          resolve({
            ok: true,
            statusCode: responseStatusCode,
            responseText: responseText.trim() || "OK"
          });
          return;
        }

        reject(error);
      });
    });

    request.setTimeout(120000, () => {
      request.destroy(new Error("Timed out while sending the OTA firmware."));
    });

    request.on("error", (error) => {
      if (responseStatusCode >= 200 && responseStatusCode < 300) {
        resolve({
          ok: true,
          statusCode: responseStatusCode,
          responseText: responseText.trim() || "OK"
        });
        return;
      }

      reject(error);
    });

    request.write(requestBody);
    request.end();
  });
}

async function uploadFirmwareDirectly(firmware, otaBaseUrl = config.otaUrl) {
  const response = await uploadFirmwareWithHttp(firmware, otaBaseUrl);

  if (!response.ok || String(response.responseText || "").trim().toUpperCase() !== "OK") {
    throw new Error(
      `ESP OTA upload did not finish successfully. Device replied with: ${response.responseText || response.statusCode}.`
    );
  }

  return {
    responseText: String(response.responseText || "").trim() || "OK",
    uploadedAt: new Date().toISOString(),
    uploadMode: "direct-request"
  };
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isIpv4Address(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

function normalizeEsp32Id(value) {
  return String(value || "").trim().toLowerCase();
}

function createBaseUrl(protocol, host) {
  return `${protocol}//${host}`;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getDiscoveryPrefixes() {
  const prefixes = new Set();

  try {
    const configuredUrl = new URL(config.otaUrl);

    if (isIpv4Address(configuredUrl.hostname)) {
      prefixes.add(configuredUrl.hostname.split(".").slice(0, 3).join("."));
    }
  } catch {
    // Ignore malformed config URLs here because other callers surface them directly.
  }

  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const addressInfo of addresses || []) {
      if (
        !addressInfo ||
        addressInfo.family !== "IPv4" ||
        addressInfo.internal ||
        !isIpv4Address(addressInfo.address)
      ) {
        continue;
      }

      prefixes.add(addressInfo.address.split(".").slice(0, 3).join("."));
    }
  }

  return [...prefixes];
}

async function probeDiagnosticsAtBaseUrl(baseUrl, esp32Id, timeoutMs = 1500) {
  const diagnostics = await httpGetJson(new URL("/diagnostics.json", baseUrl).toString(), timeoutMs);

  if (
    esp32Id &&
    normalizeEsp32Id(diagnostics?.deviceId) &&
    normalizeEsp32Id(diagnostics.deviceId) !== normalizeEsp32Id(esp32Id)
  ) {
    throw new Error(
      `Found diagnostics for a different device ID at ${baseUrl}.`
    );
  }

  return {
    diagnostics,
    otaBaseUrl: createBaseUrl(new URL(baseUrl).protocol, new URL(baseUrl).host)
  };
}

async function discoverDiagnosticsEndpoint(esp32Id, timeoutMs = 15000) {
  const configured = new URL(config.otaUrl);
  const protocol = configured.protocol;
  const hosts = new Set([configured.host]);

  for (const prefix of getDiscoveryPrefixes()) {
    for (let hostNumber = 1; hostNumber <= 254; hostNumber += 1) {
      hosts.add(`${prefix}.${hostNumber}`);
    }
  }

  const hostList = [...hosts];
  const deadline = Date.now() + timeoutMs;

  for (let startIndex = 0; startIndex < hostList.length && Date.now() < deadline; startIndex += subnetDiscoveryConcurrency) {
    const batch = hostList.slice(startIndex, startIndex + subnetDiscoveryConcurrency);
    const perProbeTimeout = Math.max(
      500,
      Math.min(1500, deadline - Date.now())
    );
    const results = await Promise.allSettled(
      batch.map((host) =>
        probeDiagnosticsAtBaseUrl(createBaseUrl(protocol, host), esp32Id, perProbeTimeout)
      )
    );
    const match = results.find((result) => result.status === "fulfilled");

    if (match && match.status === "fulfilled") {
      return match.value;
    }
  }

  return null;
}

async function discoverOtaPageEndpoint(timeoutMs = 30000) {
  try {
    const uploadTarget = await findEspUploadTarget();
    const serialIp = await readSerialIp(uploadTarget.address, Math.min(timeoutMs, 20000));
    return await probeOtaBaseUrl(serialIp.otaBaseUrl, 5000);
  } catch {
    // Serial IP output is best-effort. Fall through to network discovery.
  }

  const configured = new URL(config.otaUrl);
  const protocol = configured.protocol;
  const hosts = new Set([configured.host]);

  for (const prefix of getDiscoveryPrefixes()) {
    for (let hostNumber = 1; hostNumber <= 254; hostNumber += 1) {
      hosts.add(`${prefix}.${hostNumber}`);
    }
  }

  const hostList = [...hosts];
  const deadline = Date.now() + timeoutMs;

  for (
    let startIndex = 0;
    startIndex < hostList.length && Date.now() < deadline;
    startIndex += subnetDiscoveryConcurrency
  ) {
    const batch = hostList.slice(startIndex, startIndex + subnetDiscoveryConcurrency);
    const perProbeTimeout = Math.max(
      750,
      Math.min(2000, deadline - Date.now())
    );
    const results = await Promise.allSettled(
      batch.map((host) =>
        probeOtaBaseUrl(createBaseUrl(protocol, host), perProbeTimeout)
      )
    );
    const match = results.find((result) => result.status === "fulfilled");

    if (match && match.status === "fulfilled") {
      return match.value;
    }
  }

  return null;
}

function parseSerialDiagnosticsOutput(outputText) {
  const lines = String(outputText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let diagnostics = null;
  let otaBaseUrl = null;

  for (const line of lines) {
    if (line.startsWith("HARDVARE_IP=")) {
      const ipAddress = line.slice("HARDVARE_IP=".length).trim();

      if (ipAddress && ipAddress.toLowerCase() !== "offline" && isIpv4Address(ipAddress)) {
        otaBaseUrl = `http://${ipAddress}`;
      }
    }

    if (line.startsWith("HARDVARE_DIAGNOSTICS=")) {
      diagnostics = JSON.parse(line.slice("HARDVARE_DIAGNOSTICS=".length));
    }
  }

  return {
    diagnostics,
    otaBaseUrl,
    serialLines: lines
  };
}

function parseSerialIpOutput(outputText) {
  const lines = String(outputText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matchingLine = lines.find((line) => line.startsWith("HARDVARE_IP="));

  if (!matchingLine) {
    return null;
  }

  const ipAddress = matchingLine.slice("HARDVARE_IP=".length).trim();

  if (!ipAddress || ipAddress.toLowerCase() === "offline" || !isIpv4Address(ipAddress)) {
    return null;
  }

  return {
    otaBaseUrl: `http://${ipAddress}`,
    serialLines: lines
  };
}

function readSerialIp(portAddress, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const safePort = String(portAddress || "").replace(/'/g, "''");
    const serialScript = [
      `$port = New-Object System.IO.Ports.SerialPort '${safePort}',115200,'None',8,'one'`,
      "$port.NewLine = \"`n\"",
      "$port.ReadTimeout = 1000",
      "$port.DtrEnable = $false",
      "$port.RtsEnable = $false",
      "$deadline = [DateTime]::UtcNow.AddMilliseconds(" + Number(timeoutMs) + ")",
      "try {",
      "  $port.Open()",
      "  while ([DateTime]::UtcNow -lt $deadline) {",
      "    try {",
      "      $line = $port.ReadLine()",
      "      if ($line) {",
      "        $trimmed = $line.Trim()",
      "        if ($trimmed) {",
      "          Write-Output $trimmed",
      "          if ($trimmed.StartsWith('HARDVARE_IP=')) { break }",
      "        }",
      "      }",
      "    } catch [System.TimeoutException] { }",
      "  }",
      "} finally {",
      "  if ($port -and $port.IsOpen) { $port.Close() }",
      "}"
    ].join("; ");
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        serialScript
      ],
      {
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(
          new Error(
            String(stderr || `Serial IP reader exited with code ${code}.`).trim()
          )
        );
        return;
      }

      const parsed = parseSerialIpOutput(stdout);

      if (!parsed) {
        reject(
          new Error(
            String(stderr || "The ESP32 did not emit a live IP address over USB serial.").trim()
          )
        );
        return;
      }

      resolve(parsed);
    });
  });
}

function readSerialDiagnostics(portAddress, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const safePort = String(portAddress || "").replace(/'/g, "''");
    const serialScript = [
      `$port = New-Object System.IO.Ports.SerialPort '${safePort}',115200,'None',8,'one'`,
      "$port.NewLine = \"`n\"",
      "$port.ReadTimeout = 1000",
      "$port.DtrEnable = $false",
      "$port.RtsEnable = $false",
      "$deadline = [DateTime]::UtcNow.AddMilliseconds(" + Number(timeoutMs) + ")",
      "$lines = New-Object System.Collections.Generic.List[string]",
      "try {",
      "  $port.Open()",
      "  while ([DateTime]::UtcNow -lt $deadline) {",
      "    try {",
      "      $line = $port.ReadLine()",
      "      if ($line) {",
      "        $trimmed = $line.Trim()",
      "        if ($trimmed) {",
      "          $lines.Add($trimmed)",
      "          Write-Output $trimmed",
      "          if ($trimmed.StartsWith('HARDVARE_DIAGNOSTICS=')) { break }",
      "        }",
      "      }",
      "    } catch [System.TimeoutException] { }",
      "  }",
      "} finally {",
      "  if ($port -and $port.IsOpen) { $port.Close() }",
      "}"
    ].join("; ");
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        serialScript
      ],
      {
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(
          new Error(
            String(stderr || `Serial diagnostics reader exited with code ${code}.`).trim()
          )
        );
        return;
      }

      try {
        const parsed = parseSerialDiagnosticsOutput(stdout);

        if (!parsed.diagnostics) {
          reject(
            new Error(
              String(stderr || "The ESP32 did not emit diagnostic JSON over USB serial.").trim()
            )
          );
          return;
        }

        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function httpGetJson(urlValue, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(urlValue);
    const transport = requestUrl.protocol === "https:" ? https : http;
    let responseText = "";

    const request = transport.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port || (requestUrl.protocol === "https:" ? 443 : 80),
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: "GET"
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseText += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            reject(
              new Error(
                `Diagnostics endpoint returned HTTP ${response.statusCode || 0}.`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(responseText));
          } catch (error) {
            reject(
              new Error(
                `Diagnostics endpoint returned invalid JSON. ${error.message || error}`
              )
            );
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Timed out while requesting ESP diagnostics."));
    });

    request.on("error", reject);
    request.end();
  });
}

function httpGetText(urlValue, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(urlValue);
    const transport = requestUrl.protocol === "https:" ? https : http;
    let responseText = "";

    const request = transport.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port || (requestUrl.protocol === "https:" ? 443 : 80),
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: "GET"
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseText += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            reject(
              new Error(
                `Request returned HTTP ${response.statusCode || 0}.`
              )
            );
            return;
          }

          resolve(responseText);
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Timed out while requesting the OTA page."));
    });

    request.on("error", reject);
    request.end();
  });
}

function looksLikeOtaLoginPage(bodyText) {
  const normalized = String(bodyText || "").toLowerCase();
  return (
    normalized.includes("esp32 login") &&
    normalized.includes("name=userid") &&
    normalized.includes("name=pwd")
  );
}

function looksLikeOtaUploadPage(bodyText) {
  const normalized = String(bodyText || "").toLowerCase();
  return (
    normalized.includes("upload_form") &&
    (normalized.includes("name='update'") || normalized.includes('name="update"'))
  );
}

async function probeOtaBaseUrl(baseUrl, timeoutMs = 5000) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const rootBody = await httpGetText(new URL("/", normalizedBaseUrl).toString(), timeoutMs);

  if (looksLikeOtaLoginPage(rootBody) || looksLikeOtaUploadPage(rootBody)) {
    return {
      otaBaseUrl: normalizedBaseUrl,
      pageType: looksLikeOtaUploadPage(rootBody) ? "upload" : "login"
    };
  }

  const uploadBody = await httpGetText(
    new URL("/serverIndex", normalizedBaseUrl).toString(),
    timeoutMs
  );

  if (looksLikeOtaUploadPage(uploadBody)) {
    return {
      otaBaseUrl: normalizedBaseUrl,
      pageType: "upload"
    };
  }

  throw new Error(`No OTA login page was detected at ${normalizedBaseUrl}.`);
}

async function waitForDiagnosticsJson(esp32Id, otaBaseUrl = config.otaUrl, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const diagnosticsUrl = new URL("/diagnostics.json", otaBaseUrl).toString();
  let lastError = null;
  let nextDiscoveryAt = Date.now();

  while (Date.now() < deadline) {
    try {
      const diagnostics = await httpGetJson(diagnosticsUrl, 10000);
      return {
        diagnostics,
        otaBaseUrl
      };
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= nextDiscoveryAt) {
      const discovered = await discoverDiagnosticsEndpoint(
        esp32Id,
        Math.min(15000, Math.max(1000, deadline - Date.now()))
      );

      if (discovered) {
        return discovered;
      }

      nextDiscoveryAt = Date.now() + 15000;
    }

    await wait(3000);
  }

  throw new Error(
    `Safety scanner did not report diagnostics in time. ${lastError?.message || ""}`.trim()
  );
}

async function waitForOtaPage(otaBaseUrl = config.otaUrl, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let nextDiscoveryAt = Date.now();

  while (Date.now() < deadline) {
    try {
      const otaPage = await probeOtaBaseUrl(otaBaseUrl, 5000);
      return otaPage.otaBaseUrl;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= nextDiscoveryAt) {
      const discovered = await discoverOtaPageEndpoint(
        Math.min(30000, Math.max(1000, deadline - Date.now()))
      );

      if (discovered) {
        return discovered.otaBaseUrl;
      }

      nextDiscoveryAt = Date.now() + 10000;
    }

    await wait(3000);
  }

  throw new Error(`OTA page did not come back online. ${lastError?.message || ""}`.trim());
}

async function openServerIndexPage(page, otaBaseUrl = config.otaUrl) {
  let activePage = page;

  try {
    const popupPromise = page.waitForEvent("popup", {
      timeout: 3000
    });

    await clickElementWithMouse(page, "input[type='submit']");
    activePage = await popupPromise;

    await activePage.waitForLoadState("domcontentloaded", {
      timeout: 15000
    });
  } catch {
    try {
      await page.waitForURL((url) => {
        try {
          return new URL(url.toString()).pathname === "/serverIndex";
        } catch {
          return false;
        }
      }, {
        timeout: 3000
      });
      activePage = page;
    } catch {
      await page.goto(new URL("/serverIndex", otaBaseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15000
      });
      activePage = page;
    }
  }

  return activePage;
}

async function clickElementWithMouse(page, selector) {
  const handle = await page.waitForSelector(selector, {
    state: "visible",
    timeout: 15000
  });

  if (!handle) {
    throw new Error(`Could not find a visible element for ${selector}.`);
  }

  await page.bringToFront();
  const box = await handle.boundingBox();

  if (!box) {
    throw new Error(`Could not measure the on-screen position for ${selector}.`);
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await handle.scrollIntoViewIfNeeded();
  await page.mouse.move(x, y, {
    steps: 12
  });
  await wait(150);
  await handle.click({
    force: true,
    timeout: 15000
  });
}

async function loginToOta(context, otaBaseUrl = config.otaUrl) {
  const loginPage = await context.newPage();

  await loginPage.goto(otaBaseUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15000
  });

  await loginPage.fill("input[name='userid']", config.otaUsername);
  await loginPage.fill("input[name='pwd']", config.otaPassword);

  return openServerIndexPage(loginPage, otaBaseUrl);
}

function waitForUpdateRequestFailure(page, timeoutMs) {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      page.off("requestfailed", handleRequestFailed);
      resolve(null);
    }, timeoutMs);

    function handleRequestFailed(request) {
      if (!isUpdateRequest(request)) {
        return;
      }

      clearTimeout(timeoutHandle);
      page.off("requestfailed", handleRequestFailed);
      resolve(request.failure()?.errorText || "requestfailed");
    }

    page.on("requestfailed", handleRequestFailed);
  });
}

async function prepareNativeIframeUpload(page) {
  await page.evaluate(() => {
    const form = document.getElementById("upload_form");

    if (!(form instanceof HTMLFormElement)) {
      throw new Error("OTA upload form was not found on the device page.");
    }

    let uploadFrame = document.getElementById("hardware-builder-upload-frame");

    if (!(uploadFrame instanceof HTMLIFrameElement)) {
      uploadFrame = document.createElement("iframe");
      uploadFrame.id = "hardware-builder-upload-frame";
      uploadFrame.name = "hardware-builder-upload-frame";
      uploadFrame.style.display = "none";
      document.body.appendChild(uploadFrame);
    }

    form.action = "/update";
    form.method = "POST";
    form.enctype = "multipart/form-data";
    form.setAttribute("encoding", "multipart/form-data");
    form.target = uploadFrame.name;
  });
}

async function chooseFirmwareWithMouse(page, firmware) {
  const fileSelector = "input[type='file'][name='update']";

  await page.waitForSelector(fileSelector, {
    state: "attached",
    timeout: 15000
  });

  let fileChooser = null;

  try {
    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: 5000
    });
    await clickElementWithMouse(page, "label[for='file']");
    fileChooser = await fileChooserPromise;
  } catch {
    fileChooser = null;
  }

  if (fileChooser) {
    await fileChooser.setFiles(firmware.appBinaryPath);
  } else {
    await page.setInputFiles(fileSelector, firmware.appBinaryPath);
  }

  await page.evaluate((fileName) => {
    const label = document.getElementById("file-input");
    const progress = document.getElementById("prg");

    if (label) {
      label.textContent = `   ${fileName}`;
    }

    if (progress) {
      progress.textContent = `Ready to upload ${fileName}`;
    }
  }, firmware.appBinaryFileName);

  const selectedFile = await page.$eval(fileSelector, (input) => ({
    count: input.files ? input.files.length : 0,
    name: input.files && input.files[0] ? input.files[0].name : ""
  }));

  if (!selectedFile.count) {
    throw new Error("The OTA page did not keep the selected firmware file.");
  }

  return selectedFile;
}

async function uploadFirmware(page, firmware, otaBaseUrl = config.otaUrl) {
  await chooseFirmwareWithMouse(page, firmware);
  await prepareNativeIframeUpload(page);

  const requestPromise = page
    .waitForRequest(isUpdateRequest, {
      timeout: 10000
    })
    .catch(() => null);
  const responsePromise = page
    .waitForResponse(isUpdateResponse, {
      timeout: 30000
    })
    .catch(() => null);
  const failurePromise = waitForUpdateRequestFailure(page, 30000);

  await page.evaluate(() => {
    const progress = document.getElementById("prg");

    if (progress) {
      progress.textContent = "Uploading firmware...";
    }
  });

  await clickElementWithMouse(page, "input[type='submit'][value='Update']");

  const uploadRequest = await requestPromise;

  if (uploadRequest) {
    const [uploadResponse, requestFailure] = await Promise.all([
      responsePromise,
      failurePromise
    ]);

    if (uploadResponse) {
      return parseUploadResponse(uploadResponse, "page-click-iframe-submit");
    }

    try {
      await waitForOtaPage(otaBaseUrl, 120000);
      return {
        responseText: "OK",
        uploadedAt: new Date().toISOString(),
        uploadMode: requestFailure
          ? "page-click-requested-rebooted"
          : "page-click-requested-reconnected"
      };
    } catch {
      // Fall through to the direct request fallback below.
    }
  }

  await failurePromise;
  return uploadFirmwareDirectly(firmware, otaBaseUrl);
}

async function runSafetyPreflight(page, esp32Id, otaBaseUrl = config.otaUrl) {
  const preflightArtifact = await writePreflightArtifact(esp32Id);
  const preflightFirmware = await compileFirmwareForOta({
    esp32Id,
    artifact: preflightArtifact
  });
  const uploadResult = await uploadFirmware(page, preflightFirmware, otaBaseUrl);

  await wait(5000);
  const diagnosticsResult = await waitForDiagnosticsJson(esp32Id, otaBaseUrl);
  const analysis = analyzeDiagnostics(diagnosticsResult.diagnostics);

  return {
    sourceFileName: preflightFirmware.sourceFileName,
    sourceFilePath: preflightFirmware.sourceFilePath,
    firmwareFileName: preflightFirmware.appBinaryFileName,
    firmwarePath: preflightFirmware.appBinaryPath,
    compiledAt: preflightFirmware.compiledAt,
    reusedBinary: preflightFirmware.reusedBinary,
    outputDir: preflightFirmware.outputDir,
    uploadResult: uploadResult.responseText,
    uploadMode: uploadResult.uploadMode,
    uploadedAt: uploadResult.uploadedAt,
    diagnostics: diagnosticsResult.diagnostics,
    analysis,
    otaBaseUrl: diagnosticsResult.otaBaseUrl
  };
}

function buildOfflinePreflightResult({
  esp32Id,
  preflightFirmware,
  uploadResult,
  otaBaseUrl,
  originalError,
  diagnosticsError
}) {
  const criticalIssues = [
    "The ESP32 did not come back online with diagnostics after the safety scan."
  ];
  const warnings = [
    "Safety first. Hardvare stopped before the final firmware upload because it could not verify the board state."
  ];

  if (uploadResult?.portAddress) {
    warnings.push(`USB recovery uploaded the safety scanner on ${uploadResult.portAddress}.`);
  }

  if (originalError?.message) {
    warnings.push(`Original OTA issue: ${originalError.message}`);
  }

  if (diagnosticsError?.message) {
    warnings.push(`Diagnostics issue: ${diagnosticsError.message}`);
  }

  const suggestions = [
    "Check stable USB power, ground, and Wi-Fi signal before retrying.",
    "Keep the ESP32 connected over USB so Hardvare can recover it automatically if OTA fails again.",
    "If the device changed IP address, wait for it to reconnect and then retry the upload."
  ];

  return {
    sourceFileName: preflightFirmware.sourceFileName,
    sourceFilePath: preflightFirmware.sourceFilePath,
    firmwareFileName: preflightFirmware.appBinaryFileName,
    firmwarePath: preflightFirmware.appBinaryPath,
    compiledAt: preflightFirmware.compiledAt,
    reusedBinary: preflightFirmware.reusedBinary,
    outputDir: preflightFirmware.outputDir,
    uploadResult: uploadResult?.responseText || "FAILED",
    uploadMode: uploadResult?.uploadMode || "unavailable",
    uploadedAt: uploadResult?.uploadedAt || new Date().toISOString(),
    diagnostics: null,
    analysis: {
      criticalIssues,
      warnings,
      suggestions,
      diagnosticState: "needs_attention",
      spokenSummary: criticalIssues[0]
    },
    otaBaseUrl,
    recovery: {
      attemptedForDevice: esp32Id,
      portAddress: uploadResult?.portAddress || null,
      portLabel: uploadResult?.portLabel || null
    }
  };
}

async function runSafetyPreflightWithFallback({
  context,
  esp32Id,
  otaBaseUrl
}) {
  try {
    if (!context) {
      throw new Error("OTA browser session is not available.");
    }

    const preflightPage = await loginToOta(context, otaBaseUrl);
    return await runSafetyPreflight(preflightPage, esp32Id, otaBaseUrl);
  } catch (originalError) {
    const preflightArtifact = await writePreflightArtifact(esp32Id);
    const preflightFirmware = await compileFirmwareForOta({
      esp32Id,
      artifact: preflightArtifact
    });
    const uploadResult = await uploadFirmwareOverSerial(preflightFirmware);

    await wait(3000);

    try {
      const serialDiagnostics = await readSerialDiagnostics(uploadResult.portAddress, 45000);
      const analysis = analyzeDiagnostics(serialDiagnostics.diagnostics);

      return {
        sourceFileName: preflightFirmware.sourceFileName,
        sourceFilePath: preflightFirmware.sourceFilePath,
        firmwareFileName: preflightFirmware.appBinaryFileName,
        firmwarePath: preflightFirmware.appBinaryPath,
        compiledAt: preflightFirmware.compiledAt,
        reusedBinary: preflightFirmware.reusedBinary,
        outputDir: preflightFirmware.outputDir,
        uploadResult: uploadResult.responseText,
        uploadMode: uploadResult.uploadMode,
        uploadedAt: uploadResult.uploadedAt,
        diagnostics: serialDiagnostics.diagnostics,
        analysis,
        otaBaseUrl: serialDiagnostics.otaBaseUrl || otaBaseUrl,
        recovery: {
          portAddress: uploadResult.portAddress,
          portLabel: uploadResult.portLabel,
          portProtocol: uploadResult.portProtocol,
          serialLines: serialDiagnostics.serialLines
        }
      };
    } catch (serialDiagnosticsError) {
      try {
        const diagnosticsResult = await waitForDiagnosticsJson(esp32Id, otaBaseUrl);
        const analysis = analyzeDiagnostics(diagnosticsResult.diagnostics);

        return {
          sourceFileName: preflightFirmware.sourceFileName,
          sourceFilePath: preflightFirmware.sourceFilePath,
          firmwareFileName: preflightFirmware.appBinaryFileName,
          firmwarePath: preflightFirmware.appBinaryPath,
          compiledAt: preflightFirmware.compiledAt,
          reusedBinary: preflightFirmware.reusedBinary,
          outputDir: preflightFirmware.outputDir,
          uploadResult: uploadResult.responseText,
          uploadMode: uploadResult.uploadMode,
          uploadedAt: uploadResult.uploadedAt,
          diagnostics: diagnosticsResult.diagnostics,
          analysis,
          otaBaseUrl: diagnosticsResult.otaBaseUrl,
          recovery: {
            portAddress: uploadResult.portAddress,
            portLabel: uploadResult.portLabel,
            portProtocol: uploadResult.portProtocol
          }
        };
      } catch (diagnosticsError) {
      return buildOfflinePreflightResult({
        esp32Id,
        preflightFirmware,
        uploadResult,
        otaBaseUrl,
        originalError,
        diagnosticsError:
          diagnosticsError.message && serialDiagnosticsError.message
            ? new Error(`${serialDiagnosticsError.message} ${diagnosticsError.message}`)
            : diagnosticsError.message
              ? diagnosticsError
              : serialDiagnosticsError
      });
      }
    }
  }
}

async function launchOtaBrowser() {
  const executablePath = resolveBrowserPath();
  const browser = await chromium.launch({
    headless: false,
    executablePath
  });

  activeBrowsers.add(browser);
  browser.on("disconnected", () => {
    activeBrowsers.delete(browser);
  });

  const context = await browser.newContext();

  return {
    browser,
    context,
    executablePath
  };
}

async function uploadFinalFirmwareWithFallback({
  context,
  firmware,
  otaBaseUrl
}) {
  try {
    if (!context || !otaBaseUrl) {
      throw new Error("OTA page is not reachable, so Hardvare will recover over USB.");
    }

    const resolvedOtaBaseUrl = await waitForOtaPage(otaBaseUrl);
    const finalPage = await loginToOta(context, resolvedOtaBaseUrl);
    const uploadResult = await uploadFirmware(finalPage, firmware, resolvedOtaBaseUrl);

    return {
      uploadResult,
      otaBaseUrl: resolvedOtaBaseUrl,
      pageUrl: finalPage.url()
    };
  } catch (error) {
    const uploadResult = await uploadFirmwareOverSerial(firmware);
    let resolvedOtaBaseUrl = otaBaseUrl;

    try {
      if (otaBaseUrl) {
        resolvedOtaBaseUrl = await waitForOtaPage(otaBaseUrl, 120000);
      } else {
        const discovered = await discoverOtaPageEndpoint(120000);
        resolvedOtaBaseUrl = discovered?.otaBaseUrl || null;
      }
    } catch {
      resolvedOtaBaseUrl = otaBaseUrl || null;
    }

    return {
      uploadResult,
      otaBaseUrl: resolvedOtaBaseUrl || config.otaUrl,
      pageUrl: resolvedOtaBaseUrl || config.otaUrl,
      recovery: {
        reason: error.message,
        portAddress: uploadResult.portAddress,
        portLabel: uploadResult.portLabel,
        portProtocol: uploadResult.portProtocol
      }
    };
  }
}

function buildUploadPreflightSummary(otaBaseUrl) {
  let hostname = null;

  try {
    hostname = otaBaseUrl ? new URL(otaBaseUrl).hostname : null;
  } catch {
    hostname = null;
  }

  return {
    diagnostics: {
      wifi: {
        connected: Boolean(hostname),
        ip: hostname
      }
    },
    analysis: {
      criticalIssues: [],
      warnings: hostname ? [] : ["The OTA page was offline, so Hardvare will fall back to USB recovery."],
      suggestions: [],
      diagnosticState: hostname ? "connected" : "recovery_required",
      spokenSummary: hostname
        ? "I found the ESP32 OTA page and started the automatic upload."
        : "The ESP32 OTA page is offline, so Hardvare is switching to USB recovery upload."
    },
    otaBaseUrl: otaBaseUrl || config.otaUrl
  };
}

async function openOtaConsole({ esp32Id, artifact, runMode = "initial" }) {
  const firmware = await compileFirmwareForOta({
    esp32Id,
    artifact
  });
  let executablePath = null;
  let context = null;
  let otaBaseUrl = config.otaUrl;

  try {
    const browserSession = await launchOtaBrowser();
    executablePath = browserSession.executablePath;
    context = browserSession.context;
  } catch {
    context = null;
  }

  let reachableOtaBaseUrl = null;

  try {
    reachableOtaBaseUrl = await waitForOtaPage(otaBaseUrl, 15000);
  } catch {
    reachableOtaBaseUrl = null;
  }

  const preflight = buildUploadPreflightSummary(reachableOtaBaseUrl);

  const finalUpload = await uploadFinalFirmwareWithFallback({
    context,
    firmware,
    otaBaseUrl: reachableOtaBaseUrl
  });

  return {
    state: "uploaded",
    runMode,
    openedAt: new Date().toISOString(),
    browserPath: executablePath,
    esp32Id,
    url: finalUpload.pageUrl,
    sourceFileName: firmware.sourceFileName,
    sourceFilePath: firmware.sourceFilePath,
    firmwareFileName: firmware.appBinaryFileName,
    firmwarePath: firmware.appBinaryPath,
    compiledAt: firmware.compiledAt,
    reusedBinary: firmware.reusedBinary,
    outputDir: firmware.outputDir,
    preflight,
    uploadResult: finalUpload.uploadResult.responseText,
    uploadMode: finalUpload.uploadResult.uploadMode,
    uploadedAt: finalUpload.uploadResult.uploadedAt,
    recovery: finalUpload.recovery || preflight.recovery || null
  };
}

module.exports = {
  openOtaConsole
};
