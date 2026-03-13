const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginForm = document.getElementById("login-form");
const callForm = document.getElementById("call-form");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");
const submitButton = document.getElementById("submit-button");
const loginStatusPanel = document.getElementById("login-status");
const callStatusPanel = document.getElementById("status");
const authUsername = document.getElementById("auth-username");
const metricsContainer = document.getElementById("dashboard-metrics");
const servicesContainer = document.getElementById("service-status");
const sessionList = document.getElementById("session-list");

let dashboardRefreshHandle = null;

function setPanelStatus(panel, message, tone) {
  panel.textContent = message;
  panel.dataset.tone = tone || "";
}

async function readResponsePayload(response) {
  const responseText = await response.text();

  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch {
    if (response.ok) {
      return {
        message: responseText
      };
    }

    return {
      error: responseText
    };
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "Not available";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

function toggleAuthenticatedState(isAuthenticated) {
  loginSection.classList.toggle("hidden", isAuthenticated);
  dashboardSection.classList.toggle("hidden", !isAuthenticated);
}

function renderMetrics(summary) {
  metricsContainer.innerHTML = [
    {
      label: "Sessions",
      value: summary.totalSessions
    },
    {
      label: "Generating",
      value: summary.generatingBuilds
    },
    {
      label: "Ready",
      value: summary.readyBuilds
    },
    {
      label: "OTA Active",
      value: summary.otaActive
    }
  ]
    .map(
      (metric) => `
        <article class="metric-card">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(metric.value)}</strong>
        </article>
      `
    )
    .join("");
}

function renderServices(services) {
  const cards = [
    {
      title: "Twilio",
      value: services.twilioConfigured ? services.twilioMode : "not configured"
    },
    {
      title: "OpenAI",
      value: services.openaiConfigured ? services.openaiMode : "not configured"
    },
    {
      title: "OTA URL",
      value: services.otaUrl
    },
    {
      title: "Webhook Base",
      value: services.publicBaseUrl
    }
  ];

  servicesContainer.innerHTML = cards
    .map(
      (card) => `
        <article class="service-card">
          <span>${escapeHtml(card.title)}</span>
          <strong>${escapeHtml(card.value)}</strong>
        </article>
      `
    )
    .join("");
}

function renderSessions(sessions) {
  if (!sessions.length) {
    sessionList.innerHTML = `
      <div class="empty-state">
        No device sessions yet. Start the first call from this dashboard.
      </div>
    `;
    return;
  }

  sessionList.innerHTML = sessions
    .map((session) => {
      const artifactLink = session.artifact
        ? `<a href="${encodeURI(session.artifact.publicPath)}" target="_blank" rel="noreferrer">Download sketch</a>`
        : "No sketch yet";
      const otaState = session.otaStatus?.state || "idle";

      return `
        <article class="session-card">
          <div class="session-header">
            <strong>${escapeHtml(session.esp32Id || "Unknown device")}</strong>
            <span>${escapeHtml(session.phoneNumber || "No phone number")}</span>
          </div>
          <div class="session-meta">
            <span>Build: ${escapeHtml(session.projectTitle || session.buildRequest || "Waiting for request")}</span>
            <span>Status: ${escapeHtml(session.buildStatus || "idle")}</span>
            <span>Step: ${escapeHtml(session.currentStepIndex)} / ${escapeHtml(session.stepCount)}</span>
            <span>OTA: ${escapeHtml(otaState)}</span>
            <span>Updated: ${escapeHtml(formatDate(session.updatedAt))}</span>
          </div>
          <div class="session-links">
            ${artifactLink}
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadDashboard() {
  const response = await fetch("/api/admin/dashboard", {
    credentials: "same-origin"
  });
  const result = await readResponsePayload(response);

  if (response.status === 401) {
    stopDashboardRefresh();
    toggleAuthenticatedState(false);
    authUsername.textContent = "Admin";
    setPanelStatus(loginStatusPanel, "Please log in to open the dashboard.", "pending");
    return false;
  }

  if (!response.ok) {
    throw new Error(result.error || "Unable to load the dashboard.");
  }

  authUsername.textContent = result.admin.username;
  renderMetrics(result.summary);
  renderServices(result.services);
  renderSessions(result.recentSessions || []);
  return true;
}

function startDashboardRefresh() {
  stopDashboardRefresh();
  dashboardRefreshHandle = window.setInterval(() => {
    loadDashboard().catch((error) => {
      setPanelStatus(callStatusPanel, error.message, "error");
    });
  }, 15000);
}

function stopDashboardRefresh() {
  if (dashboardRefreshHandle) {
    window.clearInterval(dashboardRefreshHandle);
    dashboardRefreshHandle = null;
  }
}

async function refreshSession() {
  const response = await fetch("/api/admin/session", {
    credentials: "same-origin"
  });
  const result = await readResponsePayload(response);

  if (!result.authenticated) {
    toggleAuthenticatedState(false);
    stopDashboardRefresh();
    return;
  }

  toggleAuthenticatedState(true);
  authUsername.textContent = result.username;
  await loadDashboard();
  startDashboardRefresh();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const payload = {
    username: String(formData.get("username") || ""),
    password: String(formData.get("password") || "")
  };

  loginButton.disabled = true;
  setPanelStatus(loginStatusPanel, "Signing in to the dashboard...", "pending");

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const result = await readResponsePayload(response);

    if (!response.ok) {
      throw new Error(result.error || "Unable to sign in.");
    }

    setPanelStatus(loginStatusPanel, result.message, "success");
    await refreshSession();
    loginForm.reset();
    document.getElementById("username").value = "esphardvare";
    setPanelStatus(callStatusPanel, "Dashboard ready. You can start a call now.", "success");
  } catch (error) {
    setPanelStatus(loginStatusPanel, error.message, "error");
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } finally {
    stopDashboardRefresh();
    toggleAuthenticatedState(false);
    authUsername.textContent = "Admin";
    setPanelStatus(loginStatusPanel, "You have been logged out.", "pending");
    setPanelStatus(callStatusPanel, "", "");
    logoutButton.disabled = false;
  }
});

callForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(callForm);
  const payload = {
    phoneNumber: String(formData.get("phoneNumber") || ""),
    pin: String(formData.get("pin") || ""),
    esp32Id: String(formData.get("esp32Id") || "")
  };

  submitButton.disabled = true;
  setPanelStatus(callStatusPanel, "Starting the call...", "pending");

  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const result = await readResponsePayload(response);

    if (response.status === 401) {
      toggleAuthenticatedState(false);
      stopDashboardRefresh();
      throw new Error("Your admin session expired. Please log in again.");
    }

    if (!response.ok) {
      throw new Error(result.error || "Unable to start the call.");
    }

    const modeLabel =
      result.mode === "mock"
        ? "Mock mode is enabled, so the app created a simulated call."
        : "The outbound call was requested successfully.";

    setPanelStatus(
      callStatusPanel,
      `${result.message} ${modeLabel} Device ID: ${result.esp32Id}. Call SID: ${result.callSid}`,
      "success"
    );

    callForm.reset();
    document.getElementById("esp32Id").value = payload.esp32Id || "pbl-129872L";
    await loadDashboard();
  } catch (error) {
    setPanelStatus(callStatusPanel, error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

refreshSession().catch((error) => {
  setPanelStatus(loginStatusPanel, error.message, "error");
});
