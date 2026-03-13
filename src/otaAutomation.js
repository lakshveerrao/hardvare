const fs = require("fs");
const http = require("http");
const https = require("https");
const { chromium } = require("playwright-core");
const { config } = require("./config");
const { compileFirmwareForOta } = require("./firmwareBuilder");

const knownChromePaths = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
];

const activeBrowsers = new Set();

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

function uploadFirmwareWithHttp(firmware) {
  return new Promise((resolve, reject) => {
    const uploadUrl = new URL("/update", config.otaUrl);
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

async function uploadFirmwareDirectly(firmware) {
  const response = await uploadFirmwareWithHttp(firmware);

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

async function openServerIndexPage(page) {
  let activePage = page;

  try {
    const popupPromise = page.waitForEvent("popup", {
      timeout: 5000
    });

    await page.click("input[type='submit']");
    activePage = await popupPromise;

    await activePage.waitForLoadState("domcontentloaded", {
      timeout: 15000
    });
  } catch {
    await page.goto(new URL("/serverIndex", config.otaUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    activePage = page;
  }

  return activePage;
}

async function uploadFirmware(page, firmware) {
  await page.waitForSelector("input[type='file'][name='update']", {
    state: "attached",
    timeout: 15000
  });
  await page.setInputFiles("input[type='file'][name='update']", firmware.appBinaryPath);

  const uploadResponsePromise = page
    .waitForResponse(isUpdateResponse, {
      timeout: 15000
    })
    .catch(() => null);

  await page.click("input[type='submit'][value='Update']", {
    noWaitAfter: true
  });

  const uploadResponse = await uploadResponsePromise;

  if (uploadResponse) {
    return parseUploadResponse(uploadResponse, "page-submit");
  }

  return uploadFirmwareDirectly(firmware);
}

async function openOtaConsole({ esp32Id, artifact }) {
  const firmware = await compileFirmwareForOta({
    esp32Id,
    artifact
  });
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
  const page = await context.newPage();

  await page.goto(config.otaUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15000
  });

  await page.fill("input[name='userid']", config.otaUsername);
  await page.fill("input[name='pwd']", config.otaPassword);

  const activePage = await openServerIndexPage(page);
  const uploadResult = await uploadFirmware(activePage, firmware);

  return {
    state: "uploaded",
    openedAt: new Date().toISOString(),
    browserPath: executablePath,
    esp32Id,
    url: activePage.url(),
    sourceFileName: firmware.sourceFileName,
    sourceFilePath: firmware.sourceFilePath,
    firmwareFileName: firmware.appBinaryFileName,
    firmwarePath: firmware.appBinaryPath,
    compiledAt: firmware.compiledAt,
    reusedBinary: firmware.reusedBinary,
    outputDir: firmware.outputDir,
    uploadResult: uploadResult.responseText,
    uploadMode: uploadResult.uploadMode,
    uploadedAt: uploadResult.uploadedAt
  };
}

module.exports = {
  openOtaConsole
};
