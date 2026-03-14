const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

function sanitizeFileStem(value) {
  return String(value || "hardware-builder")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "hardware-builder";
}

function escapeArduinoString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function buildSafetyScannerSketch(esp32Id) {
  return `#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <Wire.h>
#include <esp_system.h>

const char* host = "esp32";
const char* ssid = "${escapeArduinoString(config.espWifiSsid)}";
const char* password = "${escapeArduinoString(config.espWifiPassword)}";
const char* deviceId = "${escapeArduinoString(esp32Id)}";

WebServer server(80);

String style =
"<style>#file-input,input{width:100%;height:44px;border-radius:4px;margin:10px auto;font-size:15px}"
"input{background:#f1f1f1;border:0;padding:0 15px}body{background:#3498db;font-family:sans-serif;font-size:14px;color:#777}"
"#file-input{padding:0;border:1px solid #ddd;line-height:44px;text-align:left;display:block;cursor:pointer}"
"#bar,#prgbar{background-color:#f1f1f1;border-radius:10px}#bar{background-color:#3498db;width:0%;height:10px}"
"form{background:#fff;max-width:258px;margin:75px auto;padding:30px;border-radius:5px;text-align:center}"
".btn{background:#3498db;color:#fff;cursor:pointer}</style>";

String loginIndex =
"<form name=loginForm onsubmit='return check(this)'>"
"<h1>ESP32 Login</h1>"
"<input name=userid placeholder='User ID'> "
"<input name=pwd placeholder=Password type=Password> "
"<input type=submit class=btn value=Login></form>"
"<script>"
"function check(form) {"
"if(form.userid.value=='admin' && form.pwd.value=='admin')"
"{window.location='/serverIndex';return false;}"
"alert('Error Password or Username');"
"return false;"
"}"
"</script>" + style;

String serverIndex =
"<form method='POST' action='/update' enctype='multipart/form-data' id='upload_form'>"
"<input type='file' name='update' id='file' onchange='sub(this)' style=display:none>"
"<label id='file-input' for='file'>   Choose file...</label>"
"<input type='submit' class=btn value='Update'>"
"<br><br>"
"<div id='prg'>Choose the firmware file to start the OTA upload.</div>"
"<br><div id='prgbar'><div id='bar'></div></div><br></form>"
"<script>"
"function sub(obj){"
"var fileName = obj.files && obj.files[0] ? obj.files[0].name : 'Choose file...';"
"document.getElementById('file-input').innerHTML = '   ' + fileName;"
"}"
"document.getElementById('upload_form').addEventListener('submit', function(e){"
"e.preventDefault();"
"var form = document.getElementById('upload_form');"
"var fileInput = document.getElementById('file');"
"if(!fileInput.files || !fileInput.files.length){"
"alert('Choose a firmware file first.');"
"return;"
"}"
"var data = new FormData(form);"
"var xhr = new window.XMLHttpRequest();"
"xhr.open('POST', '/update', true);"
"xhr.upload.addEventListener('progress', function(evt) {"
"if (evt.lengthComputable) {"
"var per = evt.loaded / evt.total;"
"document.getElementById('prg').innerHTML = 'progress: ' + Math.round(per*100) + '%';"
"document.getElementById('bar').style.width = Math.round(per*100) + '%';"
"}"
"}, false);"
"xhr.onload = function(){"
"document.getElementById('prg').innerHTML = xhr.responseText || 'Upload complete';"
"};"
"xhr.onerror = function(){"
"document.getElementById('prg').innerHTML = 'Upload failed';"
"};"
"xhr.send(data);"
"});"
"</script>" + style;

bool mdnsStarted = false;
unsigned long lastWifiAttemptAt = 0;
unsigned long lastSerialReportAt = 0;
const unsigned long wifiRetryIntervalMs = 15000;
const unsigned long wifiConnectWindowMs = 20000;
const unsigned long serialReportIntervalMs = 5000;

void tryStartMdns() {
  if (!mdnsStarted && WiFi.status() == WL_CONNECTED) {
    mdnsStarted = MDNS.begin(host);
  }
}

void maintainWifiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    tryStartMdns();
    return;
  }

  unsigned long now = millis();

  if (lastWifiAttemptAt == 0 || now - lastWifiAttemptAt >= wifiRetryIntervalMs) {
    lastWifiAttemptAt = now;
    WiFi.disconnect();
    WiFi.begin(ssid, password);
  }
}

String jsonEscape(const String& value) {
  String escaped = "";
  for (size_t index = 0; index < value.length(); index++) {
    char current = value.charAt(index);
    if (current == '\\\\') {
      escaped += "\\\\\\\\";
    } else if (current == '\"') {
      escaped += '\\\\';
      escaped += '"';
    } else if (current == '\\n') {
      escaped += "\\\\n";
    } else if (current == '\\r') {
      escaped += "\\\\r";
    } else if (current == '\\t') {
      escaped += "\\\\t";
    } else {
      escaped += current;
    }
  }
  return escaped;
}

String jsonQuoted(const String& value) {
  return String('"') + jsonEscape(value) + String('"');
}

String jsonKey(const String& key) {
  return String('"') + key + String('"') + ":";
}

String resetReasonToString(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_UNKNOWN: return "unknown";
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "other_watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "other";
  }
}

String buildI2cScanJson(int& totalDevices) {
  const int pairCount = 4;
  const int sdaPins[pairCount] = {8, 18, 21, 6};
  const int sclPins[pairCount] = {9, 17, 22, 7};
  String scans = "[";

  totalDevices = 0;

  for (int pairIndex = 0; pairIndex < pairCount; pairIndex++) {
    if (pairIndex > 0) {
      scans += ",";
    }

    Wire.begin(sdaPins[pairIndex], sclPins[pairIndex]);
    delay(25);

    String addresses = "[";
    int pairDevices = 0;

    for (uint8_t address = 8; address < 120; address++) {
      Wire.beginTransmission(address);
      uint8_t error = Wire.endTransmission();

      if (error == 0) {
        if (pairDevices > 0) {
          addresses += ",";
        }
        addresses += String(address);
        pairDevices++;
        totalDevices++;
      }
    }

    Wire.end();
    addresses += "]";

    scans += "{";
    scans += jsonKey("sda") + String(sdaPins[pairIndex]) + ",";
    scans += jsonKey("scl") + String(sclPins[pairIndex]) + ",";
    scans += jsonKey("deviceCount") + String(pairDevices) + ",";
    scans += jsonKey("addresses") + addresses;
    scans += "}";
  }

  scans += "]";
  return scans;
}

String buildGpioSnapshotJson() {
  const int pinCount = 14;
  const int pins[pinCount] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14};
  String snapshot = "[";

  for (int index = 0; index < pinCount; index++) {
    if (index > 0) {
      snapshot += ",";
    }

    pinMode(pins[index], INPUT_PULLUP);
    delay(2);

    snapshot += "{";
    snapshot += jsonKey("pin") + String(pins[index]) + ",";
    snapshot += jsonKey("digital") + String(digitalRead(pins[index]));
    snapshot += "}";
  }

  return snapshot + "]";
}

String buildWarningsJson(bool wifiConnected, bool brownout, int totalI2cDevices) {
  String warnings = "[";
  bool hasWarning = false;

  if (!wifiConnected) {
    warnings += jsonQuoted("WiFi is not connected, so OTA may be unstable.");
    hasWarning = true;
  }

  if (brownout) {
    if (hasWarning) {
      warnings += ",";
    }
    warnings += jsonQuoted("Brownout reset detected. Check power and ground before running the final build.");
    hasWarning = true;
  }

  if (totalI2cDevices == 0) {
    if (hasWarning) {
      warnings += ",";
    }
    warnings += jsonQuoted("No I2C devices were detected on the common scan pairs.");
  }

  return warnings + "]";
}

String buildDiagnosticsJson() {
  bool wifiConnected = WiFi.status() == WL_CONNECTED;
  esp_reset_reason_t resetReason = esp_reset_reason();
  bool brownout = resetReason == ESP_RST_BROWNOUT;
  int totalI2cDevices = 0;
  String i2cScans = buildI2cScanJson(totalI2cDevices);
  String gpioSnapshot = buildGpioSnapshotJson();
  String warnings = buildWarningsJson(wifiConnected, brownout, totalI2cDevices);
  String ipAddress = wifiConnected ? WiFi.localIP().toString() : "0.0.0.0";
  long rssi = wifiConnected ? WiFi.RSSI() : 0;

  String json = "{";
  json += jsonKey("deviceId") + jsonQuoted(String(deviceId)) + ",";
  json += jsonKey("sketch") + jsonQuoted("preflight_safety_scan") + ",";
  json += jsonKey("uptimeMs") + String(millis()) + ",";
  json += jsonKey("freeHeap") + String(ESP.getFreeHeap()) + ",";
  json += jsonKey("wifi") + "{";
  json += jsonKey("connected") + String(wifiConnected ? "true" : "false") + ",";
  json += jsonKey("ip") + jsonQuoted(ipAddress) + ",";
  json += jsonKey("rssi") + String(rssi);
  json += "},";
  json += jsonKey("power") + "{";
  json += jsonKey("resetReason") + jsonQuoted(resetReasonToString(resetReason)) + ",";
  json += jsonKey("brownoutSuspected") + String(brownout ? "true" : "false");
  json += "},";
  json += jsonKey("i2cScans") + i2cScans + ",";
  json += jsonKey("gpioSnapshot") + gpioSnapshot + ",";
  json += jsonKey("warnings") + warnings;
  json += "}";
  return json;
}

void reportWifiStatusToSerial() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("HARDVARE_IP=" + WiFi.localIP().toString());
  } else {
    Serial.println("HARDVARE_IP=offline");
  }
}

void reportDiagnosticsToSerial() {
  Serial.println("HARDVARE_DEVICE_ID=" + String(deviceId));
  reportWifiStatusToSerial();
  Serial.println("HARDVARE_DIAGNOSTICS=" + buildDiagnosticsJson());
}

void setup(void) {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  maintainWifiConnection();

  unsigned long connectDeadline = millis() + wifiConnectWindowMs;
  while (WiFi.status() != WL_CONNECTED && millis() < connectDeadline) {
    delay(250);
    Serial.print(".");
  }

  tryStartMdns();

  server.on("/", HTTP_GET, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "text/html", loginIndex);
  });

  server.on("/serverIndex", HTTP_GET, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "text/html", serverIndex);
  });

  server.on("/diagnostics.json", HTTP_GET, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "application/json", buildDiagnosticsJson());
  });

  server.on("/update", HTTP_POST, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "text/plain", (Update.hasError()) ? "FAIL" : "OK");
    ESP.restart();
  }, []() {
    HTTPUpload& upload = server.upload();
    if (upload.status == UPLOAD_FILE_START) {
      if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
        Update.printError(Serial);
      }
    } else if (upload.status == UPLOAD_FILE_WRITE) {
      if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
        Update.printError(Serial);
      }
    } else if (upload.status == UPLOAD_FILE_END) {
      if (!Update.end(true)) {
        Update.printError(Serial);
      }
    }
  });

  server.begin();
  delay(250);
  reportDiagnosticsToSerial();
}

void loop(void) {
  maintainWifiConnection();
  if (millis() - lastSerialReportAt >= serialReportIntervalMs) {
    lastSerialReportAt = millis();
    reportDiagnosticsToSerial();
  }
  server.handleClient();
  delay(1);
}
`;
}

async function writePreflightArtifact(esp32Id) {
  await fs.mkdir(config.generatedDir, {
    recursive: true
  });

  const fileName = `${sanitizeFileStem(esp32Id)}-safety-preflight-scan.ino`;
  const filePath = path.join(config.generatedDir, fileName);

  await fs.writeFile(filePath, buildSafetyScannerSketch(esp32Id), "utf8");

  return {
    fileName,
    filePath,
    publicPath: `/generated/${encodeURIComponent(fileName)}`
  };
}

function buildSpokenSummary(criticalIssues, warnings) {
  const notes = [...criticalIssues, ...warnings].slice(0, 2);

  if (!notes.length) {
    return "Safety scan did not find Wi-Fi or brownout problems.";
  }

  return notes.join(" ");
}

function analyzeDiagnostics(report) {
  const criticalIssues = [];
  const warnings = [];
  const suggestions = [];
  const wifiConnected = Boolean(report?.wifi?.connected);
  const brownout = Boolean(report?.power?.brownoutSuspected);
  const resetReason = String(report?.power?.resetReason || "").trim();
  const freeHeap = Number(report?.freeHeap || 0);
  const i2cScans = Array.isArray(report?.i2cScans) ? report.i2cScans : [];
  const totalI2cDevices = i2cScans.reduce(
    (sum, scan) => sum + Number(scan?.deviceCount || 0),
    0
  );

  if (!wifiConnected) {
    criticalIssues.push("Wi-Fi is not connected, so OTA upload may fail.");
    suggestions.push("Reconnect the ESP32 to Wi-Fi and reload the OTA page before retrying.");
  }

  if (brownout || resetReason === "brownout") {
    criticalIssues.push("Brownout reset detected. Power may be unstable.");
    suggestions.push(
      "Use a stable 5 volt USB power source, share ground correctly, and do not power motors or relays directly from the ESP32."
    );
  }

  if (freeHeap > 0 && freeHeap < 100000) {
    warnings.push("Free memory is lower than expected before the main firmware starts.");
  }

  if (totalI2cDevices === 0) {
    warnings.push("No I2C devices were found on the common scan pairs.");
    suggestions.push(
      "If your project uses I2C parts, check SDA, SCL, power, ground, and pull-up wiring."
    );
  }

  if (!suggestions.length) {
    suggestions.push("Recheck ground, power polarity, and the exact GPIO labels before retrying.");
  }

  return {
    criticalIssues,
    warnings,
    suggestions,
    diagnosticState: criticalIssues.length
      ? "needs_attention"
      : warnings.length
        ? "warning"
        : "clear",
    spokenSummary: buildSpokenSummary(criticalIssues, warnings)
  };
}

module.exports = {
  analyzeDiagnostics,
  writePreflightArtifact
};
