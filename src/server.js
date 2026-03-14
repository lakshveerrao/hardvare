const { createApp } = require("./app");
const { config, isRetellConfigured } = require("./config");
const { syncRetellConfiguration } = require("./retellSync");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Hardware phone bot listening on port ${config.port}`);
  console.log(`Public base URL: ${config.publicBaseUrl}`);
  console.log(`Twilio mock mode: ${config.twilioMock ? "enabled" : "disabled"}`);

  if (isRetellConfigured()) {
    syncRetellConfiguration()
      .then((result) => {
        if (result?.skipped) {
          console.log(`Retell sync skipped: ${result.reason}`);
          return;
        }

        console.log(
          `Retell synced for ${result.phoneNumber} using LLM ${result.llmId} at ${result.syncedAt}`
        );
      })
      .catch((error) => {
        console.error(`Retell sync failed: ${error.message || error}`);
      });
  }
});
