const DEFAULT_ESP32_ID = "pbl-129872L";

const BUILD_HINTS = [
  "build a traffic light",
  "build a smart irrigation system",
  "build a line follower robot",
  "build an LED project",
  "build a sensor alarm",
  "build a home automation relay"
].join(", ");

const OTA_SCAFFOLD = `#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Update.h>

const char* host = "esp32";
const char* ssid = "Laksh-2.4G";
const char* password = "fundaz76";

WebServer server(80);

String style =
"<style>#file-input,input{width:100%;height:44px;border-radius:4px;margin:10px auto;font-size:15px}"
"input{background:#f1f1f1;border:0;padding:0 15px}body{background:#3498db;font-family:sans-serif;font-size:14px;color:#777}"
"#file-input{padding:0;border:1px solid #ddd;line-height:44px;text-align:left;display:block;cursor:pointer}"
"#bar,#prgbar{background-color:#f1f1f1;border-radius:10px}#bar{background-color:#3498db;width:0%;height:10px}"
"form{background:#fff;max-width:258px;margin:75px auto;padding:30px;border-radius:5px;text-align:center}"
".btn{background:#3498db;color:#fff;cursor:pointer}</style>";

String loginIndex =
"<form name=loginForm>"
"<h1>ESP32 Login</h1>"
"<input name=userid placeholder='User ID'> "
"<input name=pwd placeholder=Password type=Password> "
"<input type=submit onclick=check(this.form) class=btn value=Login></form>"
"<script>"
"function check(form) {"
"if(form.userid.value=='admin' && form.pwd.value=='admin')"
"{window.open('/serverIndex')}"
"else"
"{alert('Error Password or Username')}"
"}"
"</script>" + style;

String serverIndex =
"<script src='https://ajax.googleapis.com/ajax/libs/jquery/3.2.1/jquery.min.js'></script>"
"<form method='POST' action='#' enctype='multipart/form-data' id='upload_form'>"
"<input type='file' name='update' id='file' onchange='sub(this)' style=display:none>"
"<label id='file-input' for='file'>   Choose file...</label>"
"<input type='submit' class=btn value='Update'>"
"<br><br>"
"<div id='prg'></div>"
"<br><div id='prgbar'><div id='bar'></div></div><br></form>"
"<script>"
"function sub(obj){"
"var fileName = obj.value.split('\\\\');"
"document.getElementById('file-input').innerHTML = '   '+ fileName[fileName.length-1];"
"};"
"$('form').submit(function(e){"
"e.preventDefault();"
"var form = $('#upload_form')[0];"
"var data = new FormData(form);"
"$.ajax({"
"url: '/update',"
"type: 'POST',"
"data: data,"
"contentType: false,"
"processData:false,"
"xhr: function() {"
"var xhr = new window.XMLHttpRequest();"
"xhr.upload.addEventListener('progress', function(evt) {"
"if (evt.lengthComputable) {"
"var per = evt.loaded / evt.total;"
"$('#prg').html('progress: ' + Math.round(per*100) + '%');"
"$('#bar').css('width',Math.round(per*100) + '%');"
"}"
"}, false);"
"return xhr;"
"},"
"success:function(d, s) {"
"console.log('success!') "
"},"
"error: function (a, b, c) {"
"}"
"});"
"});"
"</script>" + style;

void setup(void) {
  Serial.begin(115200);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  if (!MDNS.begin(host)) {
    while (1) {
      delay(1000);
    }
  }

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
  server.handleClient();
  delay(1);
}`;

const BUILDER_SYSTEM_PROMPT = `You are Hardware Builder, an expert ESP32 wiring and firmware assistant.

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
- Keep spoken instructions short and clear.
- Each wiring step must describe exactly one connection.
- Use real ESP32 GPIO labels.
- Do not invent dangerous mains-voltage wiring.
- Make reasonable assumptions if parts are missing.
- Mention assumptions in spokenIntro.
- Preserve OTA functionality and the OTA login flow from the scaffold.
- Keep the generated sketch in Arduino C++ for ESP32.

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
