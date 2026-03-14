const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const signedInBanner = document.getElementById("signed-in-banner");
const signedInCopy = document.getElementById("signed-in-copy");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const callForm = document.getElementById("call-form");
const loginButton = document.getElementById("login-button");
const signupButton = document.getElementById("signup-button");
const logoutButton = document.getElementById("logout-button");
const submitButton = document.getElementById("submit-button");
const loginStatusPanel = document.getElementById("login-status");
const signupStatusPanel = document.getElementById("signup-status");
const callStatusPanel = document.getElementById("status");
const authUsername = document.getElementById("auth-username");
const authRole = document.getElementById("auth-role");
const dashboardCopy = document.getElementById("dashboard-copy");
const metricsContainer = document.getElementById("dashboard-metrics");
const servicesContainer = document.getElementById("service-status");
const sessionList = document.getElementById("session-list");
const startBuildLinks = Array.from(document.querySelectorAll("[data-start-build-link]"));

let dashboardRefreshHandle = null;
let currentAccountRole = "user";

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
  if (signedInBanner) {
    signedInBanner.classList.toggle("hidden", !isAuthenticated);
  }
  updateStartBuildTargets(isAuthenticated);
}

function updateAccountBanner(username, role) {
  currentAccountRole = role || "user";
  authUsername.textContent = username || "User";
  authRole.textContent = currentAccountRole;
  authRole.dataset.role = currentAccountRole;
  if (signedInCopy) {
    signedInCopy.textContent =
      currentAccountRole === "admin"
        ? "You are signed in as admin. Review the platform state or jump straight into a live build call."
        : `Signed in as ${username || "User"}. Continue with a build call or review your saved sessions.`;
  }
  dashboardCopy.textContent =
    currentAccountRole === "admin"
      ? "You are signed in as admin, so you can see every saved call session."
      : "You are signed in with your own saved account, so the dashboard only shows your sessions.";
}

function updateStartBuildTargets(isAuthenticated) {
  const nextTarget = isAuthenticated ? "#dashboard-section" : "#access-section";

  startBuildLinks.forEach((link) => {
    link.setAttribute("href", nextTarget);
  });
}

function scrollToSection(section) {
  if (section && typeof section.scrollIntoView === "function") {
    section.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
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
      title: "Call Provider",
      value: services.callProviderConfigured
        ? `${services.callProvider} (${services.providerStatus || "configured"})`
        : "not configured"
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
      const validationState = session.validationState || "pending";
      const safetyLine = session.safetySummary
        ? `<span>Safety: ${escapeHtml(session.safetySummary)}</span>`
        : "";
      const diagnosticsLine = session.diagnostics
        ? `<span>Scan: Wi-Fi ${session.diagnostics.wifiConnected ? "connected" : "offline"}, I2C devices ${escapeHtml(session.diagnostics.i2cDeviceCount)}, reset ${escapeHtml(session.diagnostics.resetReason || "unknown")}</span>`
        : "";
      const recoveryLine = session.recovery?.portAddress
        ? `<span>Recovery: USB ${escapeHtml(session.recovery.portAddress)}</span>`
        : "";
      const firmwareLine = session.firmwareFileName
        ? `<span>Firmware: ${escapeHtml(session.firmwareFileName)}</span>`
        : "";
      const ownerLine =
        currentAccountRole === "admin" && session.ownerUsername
          ? `<span>Owner: ${escapeHtml(session.ownerUsername)}</span>`
          : "";

      return `
        <article class="session-card">
          <div class="session-header">
            <strong>${escapeHtml(session.esp32Id || "Unknown device")}</strong>
            <span>${escapeHtml(session.phoneNumber || "No phone number")}</span>
          </div>
          <div class="session-meta">
            ${ownerLine}
            <span>Build: ${escapeHtml(session.projectTitle || session.buildRequest || "Waiting for request")}</span>
            <span>Status: ${escapeHtml(session.buildStatus || "idle")}</span>
            <span>Validation: ${escapeHtml(validationState)}</span>
            <span>Step: ${escapeHtml(session.currentStepIndex)} / ${escapeHtml(session.stepCount)}</span>
            <span>OTA: ${escapeHtml(otaState)}</span>
            ${firmwareLine}
            ${safetyLine}
            ${diagnosticsLine}
            ${recoveryLine}
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
  const response = await fetch("/api/dashboard", {
    credentials: "same-origin"
  });
  const result = await readResponsePayload(response);

  if (response.status === 401) {
    stopDashboardRefresh();
    toggleAuthenticatedState(false);
    updateAccountBanner("User", "user");
    setPanelStatus(loginStatusPanel, "Please log in to open the dashboard.", "pending");
    return false;
  }

  if (!response.ok) {
    throw new Error(result.error || "Unable to load the dashboard.");
  }

  updateAccountBanner(result.account.username, result.account.role);
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
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin"
  });
  const result = await readResponsePayload(response);

  if (!result.authenticated) {
    toggleAuthenticatedState(false);
    stopDashboardRefresh();
    updateAccountBanner("User", "user");
    return;
  }

  toggleAuthenticatedState(true);
  updateAccountBanner(result.username, result.role);
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
  setPanelStatus(loginStatusPanel, "Signing in...", "pending");

  try {
    const response = await fetch("/api/auth/login", {
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
    setPanelStatus(signupStatusPanel, "", "");
    await refreshSession();
    loginForm.reset();
    document.getElementById("username").value = "esphardvare";
    setPanelStatus(callStatusPanel, "Dashboard ready. You can start a call now.", "success");
    scrollToSection(dashboardSection);
  } catch (error) {
    setPanelStatus(loginStatusPanel, error.message, "error");
  } finally {
    loginButton.disabled = false;
  }
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(signupForm);
  const payload = {
    username: String(formData.get("username") || ""),
    password: String(formData.get("password") || ""),
    confirmPassword: String(formData.get("confirmPassword") || "")
  };

  if (payload.password !== payload.confirmPassword) {
    setPanelStatus(signupStatusPanel, "Password confirmation does not match.", "error");
    return;
  }

  signupButton.disabled = true;
  setPanelStatus(signupStatusPanel, "Creating your saved account...", "pending");

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const result = await readResponsePayload(response);

    if (!response.ok) {
      throw new Error(result.error || "Unable to create the account.");
    }

    setPanelStatus(signupStatusPanel, result.message, "success");
    setPanelStatus(loginStatusPanel, "", "");
    await refreshSession();
    signupForm.reset();
    setPanelStatus(callStatusPanel, "Your account is ready. You can start a call now.", "success");
    scrollToSection(dashboardSection);
  } catch (error) {
    setPanelStatus(signupStatusPanel, error.message, "error");
  } finally {
    signupButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } finally {
    stopDashboardRefresh();
    toggleAuthenticatedState(false);
    updateAccountBanner("User", "user");
    setPanelStatus(loginStatusPanel, "You have been logged out.", "pending");
    setPanelStatus(signupStatusPanel, "", "");
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
      throw new Error("Your session expired. Please log in again.");
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
      `${result.message} ${modeLabel} Device ID: ${result.esp32Id}. Phone: ${result.phoneNumber}. Call SID: ${result.callSid}`,
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
