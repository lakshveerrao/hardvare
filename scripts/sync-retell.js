const { syncRetellConfiguration } = require("../src/retellSync");

syncRetellConfiguration()
  .then((result) => {
    if (result?.skipped) {
      console.log(`Retell sync skipped: ${result.reason}`);
      process.exit(0);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result
        },
        null,
        2
      )
    );
  })
  .catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
