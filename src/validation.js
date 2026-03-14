function normalizePhoneNumber(phoneNumber) {
  const rawValue = String(phoneNumber || "").trim();

  if (!rawValue) {
    return "";
  }

  const digitsOnly = rawValue.replace(/\D/g, "");

  if (!digitsOnly) {
    return "";
  }

  if (rawValue.startsWith("+")) {
    return `+${digitsOnly}`;
  }

  if (rawValue.startsWith("00") && digitsOnly.length > 2) {
    return `+${digitsOnly.slice(2)}`;
  }

  return `+${digitsOnly}`;
}

function normalizePin(pin) {
  return String(pin || "").trim();
}

function normalizeEspDeviceId(deviceId) {
  return String(deviceId || "").trim();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function normalizePassword(password) {
  return String(password || "");
}

function normalizeDeviceText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeFeedback(value) {
  return normalizeDeviceText(value);
}

function canonicalUsername(username) {
  return normalizeUsername(username).toLowerCase();
}

function hasLengthInRange(value, minimum, maximum) {
  return value.length >= minimum && value.length <= maximum;
}

function isValidPhoneNumber(phoneNumber) {
  return /^\+\d{7,15}$/.test(normalizePhoneNumber(phoneNumber));
}

function isValidPin(pin) {
  return /^\d{4,8}$/.test(normalizePin(pin));
}

function isValidEspDeviceId(deviceId) {
  return /^[A-Za-z0-9-]{4,64}$/.test(normalizeEspDeviceId(deviceId));
}

function isValidUsername(username) {
  return /^[A-Za-z0-9._-]{3,32}$/.test(normalizeUsername(username));
}

function isValidPassword(password) {
  const normalized = normalizePassword(password);
  return hasLengthInRange(normalized, 4, 72) && /\S/.test(normalized);
}

function isValidDeviceText(value, minimum = 1, maximum = 160) {
  return hasLengthInRange(normalizeDeviceText(value), minimum, maximum);
}

function isValidFeedback(value) {
  return normalizeFeedback(value).length <= 400;
}

module.exports = {
  canonicalUsername,
  isValidDeviceText,
  isValidEspDeviceId,
  isValidFeedback,
  isValidPassword,
  isValidPhoneNumber,
  isValidPin,
  isValidUsername,
  normalizeDeviceText,
  normalizeFeedback,
  normalizePassword,
  normalizePhoneNumber,
  normalizeEspDeviceId,
  normalizePin,
  normalizeUsername
};
