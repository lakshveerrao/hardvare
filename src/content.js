const { config } = require("./config");

const DEFAULT_ESP32_ID = "pbl-129872L";

const BUILD_HINTS = [
  "build a traffic light",
  "build a smart irrigation system",
  "build a line follower robot",
  "build an LED project",
  "build a sensor alarm",
  "build a home automation relay"
].join(", ");

function escapeArduinoString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

const OTA_SCAFFOLD = `#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Update.h>

const char* host = "esp32";
const char* ssid = "${escapeArduinoString(config.espWifiSsid)}";
const char* password = "${escapeArduinoString(config.espWifiPassword)}";

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
unsigned long lastWifiReportAt = 0;
const unsigned long wifiRetryIntervalMs = 15000;
const unsigned long wifiConnectWindowMs = 20000;
const unsigned long wifiReportIntervalMs = 15000;

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

void reportWifiStatusToSerial() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("HARDVARE_IP=" + WiFi.localIP().toString());
  } else {
    Serial.println("HARDVARE_IP=offline");
  }
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
  reportWifiStatusToSerial();

  server.on("/", HTTP_GET, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "text/html", loginIndex);
  });

  server.on("/serverIndex", HTTP_GET, []() {
    server.sendHeader("Connection", "close");
    server.send(200, "text/html", serverIndex);
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
}

void loop(void) {
  maintainWifiConnection();
  if (millis() - lastWifiReportAt >= wifiReportIntervalMs) {
    lastWifiReportAt = millis();
    reportWifiStatusToSerial();
  }
  server.handleClient();
  delay(1);
}`;

const BUILDER_SYSTEM_PROMPT = `You are Hardware Builder, an expert ESP32 wiring and firmware assistant. Safety first is the highest priority.

You will receive:
- an ESP32 device ID
- a build request from a phone caller
- an OTA scaffold that must remain part of the final sketch

Your job:
1. Decide on a safe, simple ESP32 build for the request.
2. Return one-pin-at-a-time wiring steps that are easy to speak over a phone call.
3. Generate a complete Arduino sketch for ESP32 that integrates the requested project logic into the OTA scaffold.

Rules:
- Return JSON only. Do not wrap it in markdown.
- Put safety first before convenience or feature count.
- Keep spoken instructions short and clear.
- Each wiring step must describe exactly one connection.
- Use real ESP32 GPIO labels.
- Do not invent dangerous mains-voltage wiring.
- Avoid risky power advice. Prefer low-voltage, current-limited, and clearly grounded wiring.
- Make reasonable assumptions if parts are missing.
- Mention assumptions in spokenIntro.
- Preserve OTA functionality and the OTA login flow from the scaffold.
- Keep the generated sketch in Arduino C++ for ESP32.
- For servo projects on ESP32, use ESP32Servo, not Servo.h.
- For DHT11 or DHT22 projects, use the common DHT sensor library with DHT.h.
- Do not add manual forward declarations for ledcWrite or other ESP32 core functions.
- If the caller says an unknown sensor name that sounds like DHT, choose DHT11 or DHT22 and say that assumption in spokenIntro.

JSON shape:
{
  "projectTitle": "short title",
  "spokenIntro": "short summary for the phone call",
  "parts": ["part 1", "part 2"],
  "steps": [
    {
      "title": "short step title",
      "spokenInstruction": "one connection only, spoken naturally"
    }
  ],
  "sketchFileName": "hardware_builder_project.ino",
  "sketch": "full Arduino sketch source"
}`;

module.exports = {
  BUILD_HINTS,
  BUILDER_SYSTEM_PROMPT,
  DEFAULT_ESP32_ID,
  OTA_SCAFFOLD
};
