const { createApp } = require("./app");
const { config } = require("./config");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Hardware phone bot listening on port ${config.port}`);
  console.log(`Public base URL: ${config.publicBaseUrl}`);
  console.log(`Twilio mock mode: ${config.twilioMock ? "enabled" : "disabled"}`);
});
