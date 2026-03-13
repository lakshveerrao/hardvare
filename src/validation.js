function normalizePhoneNumber(phoneNumber) {
  return String(phoneNumber || "").trim().replace(/\s+/g, "");
}

function normalizePin(pin) {
  return String(pin || "").trim();
}

function normalizeEspDeviceId(deviceId) {
  return String(deviceId || "").trim();
}

function isValidPhoneNumber(phoneNumber) {
  return /^\+[1-9]\d{7,14}$/.test(normalizePhoneNumber(phoneNumber));
}

function isValidPin(pin) {
  return /^\d{4,8}$/.test(normalizePin(pin));
}

function isValidEspDeviceId(deviceId) {
  return /^[A-Za-z0-9-]{4,64}$/.test(normalizeEspDeviceId(deviceId));
}

module.exports = {
  isValidEspDeviceId,
  normalizePhoneNumber,
  normalizeEspDeviceId,
  normalizePin,
  isValidPhoneNumber,
  isValidPin
};
