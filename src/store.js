const fs = require("fs/promises");
const path = require("path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("crypto");
const { config } = require("./config");
const { canonicalUsername, normalizeUsername } = require("./validation");

function createDefaultState() {
  return {
    users: {},
    phoneIndex: {},
    deviceIndex: {},
    devices: {},
    devicePblIndex: {},
    accounts: {},
    accountIndex: {}
  };
}

let writeQueue = Promise.resolve();

async function ensureStoreFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });

  try {
    await fs.access(config.dataFile);
  } catch {
    await fs.writeFile(
      config.dataFile,
      JSON.stringify(createDefaultState(), null, 2),
      "utf8"
    );
  }
}

function hashSecret(value) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(value, salt, 64).toString("hex");

  return { salt, hash };
}

function verifySecret(value, salt, hash) {
  const expected = Buffer.from(String(hash || ""), "hex");
  const actual = Buffer.from(scryptSync(value, salt, 64).toString("hex"), "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function writeState(state) {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(config.dataFile, JSON.stringify(state, null, 2), "utf8")
  );

  return writeQueue;
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role || "user",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    pblId: device.pblId,
    deviceId: device.deviceId,
    hardware: device.hardware,
    firmware: device.firmware,
    make: device.make,
    manufacturer: device.manufacturer,
    power: device.power,
    ports: device.ports,
    pins: device.pins,
    feedback: device.feedback || "",
    buildCount: device.buildCount || 0,
    ownerAccountId: device.ownerAccountId || null,
    ownerUsername: device.ownerUsername || null,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt
  };
}

function publicUser(user) {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    esp32Id: user.esp32Id || null,
    devicePblId: user.devicePblId || null,
    deviceLabel: user.deviceLabel || null,
    ownerAccountId: user.ownerAccountId || null,
    ownerUsername: user.ownerUsername || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastCallSid: user.lastCallSid || null,
    buildRequest: user.buildRequest || null,
    buildStatus: user.buildStatus || null,
    buildError: user.buildError || null,
    buildPlan:
      user.buildPlan && {
        projectTitle: user.buildPlan.projectTitle,
        spokenIntro: user.buildPlan.spokenIntro,
        stepCount: Array.isArray(user.buildPlan.steps) ? user.buildPlan.steps.length : 0,
        currentStepIndex: user.currentStepIndex || 0,
        artifact: user.buildPlan.artifact || null,
        generatedAt: user.buildPlan.generatedAt || null
      },
    otaStatus: user.otaStatus || null
  };
}

function ensureAdminAccount(state) {
  const username = normalizeUsername(config.adminUsername);
  const normalizedUsername = canonicalUsername(username);

  if (!username || !normalizedUsername || !config.adminPassword) {
    return;
  }

  const now = new Date().toISOString();
  let accountId = state.accountIndex[normalizedUsername];
  let account = accountId ? state.accounts[accountId] : null;

  if (!account) {
    account = {
      id: randomUUID(),
      username,
      role: "admin",
      createdAt: now,
      updatedAt: now
    };
    const { salt, hash } = hashSecret(config.adminPassword);
    account.passwordSalt = salt;
    account.passwordHash = hash;
    state.accounts[account.id] = account;
    state.accountIndex[normalizedUsername] = account.id;
    return;
  }

  let changed = false;

  if (account.username !== username) {
    account.username = username;
    changed = true;
  }

  if (account.role !== "admin") {
    account.role = "admin";
    changed = true;
  }

  if (!verifySecret(config.adminPassword, account.passwordSalt, account.passwordHash)) {
    const { salt, hash } = hashSecret(config.adminPassword);
    account.passwordSalt = salt;
    account.passwordHash = hash;
    changed = true;
  }

  if (changed) {
    account.updatedAt = now;
    state.accounts[account.id] = account;
    state.accountIndex[normalizedUsername] = account.id;
  }
}

function createPblId(state) {
  let nextId = "";

  while (!nextId || state.devicePblIndex[nextId]) {
    const digits = Math.floor(100000 + Math.random() * 900000);
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    nextId = `pbl-${digits}${letter}`;
  }

  return nextId;
}

function buildState(parsed) {
  const state = createDefaultState();

  state.users = parsed?.users || {};
  state.phoneIndex = parsed?.phoneIndex || {};
  state.deviceIndex = parsed?.deviceIndex || {};
  state.devices = parsed?.devices || {};
  state.devicePblIndex = parsed?.devicePblIndex || {};
  state.accounts = parsed?.accounts || {};
  state.accountIndex = parsed?.accountIndex || {};

  ensureAdminAccount(state);

  return state;
}

async function readState() {
  await ensureStoreFile();
  const raw = await fs.readFile(config.dataFile, "utf8");

  if (!raw.trim()) {
    return buildState(createDefaultState());
  }

  return buildState(JSON.parse(raw));
}

async function createAccount({ username, password, role = "user" }) {
  const state = await readState();
  const now = new Date().toISOString();
  const normalizedUsername = canonicalUsername(username);

  if (state.accountIndex[normalizedUsername]) {
    const error = new Error("That username is already taken.");
    error.statusCode = 409;
    throw error;
  }

  const { salt, hash } = hashSecret(password);
  const account = {
    id: randomUUID(),
    username: normalizeUsername(username),
    role,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now
  };

  state.accounts[account.id] = account;
  state.accountIndex[normalizedUsername] = account.id;

  await writeState(state);

  return publicAccount(account);
}

async function getAccount(accountId) {
  const state = await readState();
  return state.accounts[accountId] || null;
}

async function getAccountByUsername(username) {
  const state = await readState();
  const accountId = state.accountIndex[canonicalUsername(username)];

  if (!accountId) {
    return null;
  }

  return state.accounts[accountId] || null;
}

async function listAccounts(limit = 100) {
  const state = await readState();

  return Object.values(state.accounts)
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, Math.max(0, limit))
    .map(publicAccount);
}

function verifyAccountPassword(password, account) {
  if (!account?.passwordSalt || !account?.passwordHash) {
    return false;
  }

  return verifySecret(password, account.passwordSalt, account.passwordHash);
}

async function createDevice({
  ownerAccountId,
  ownerUsername,
  deviceId,
  hardware,
  firmware,
  make,
  manufacturer,
  power,
  ports,
  pins,
  feedback
}) {
  const state = await readState();
  const now = new Date().toISOString();
  const pblId = createPblId(state);
  const device = {
    id: randomUUID(),
    pblId,
    deviceId,
    hardware,
    firmware,
    make,
    manufacturer,
    power,
    ports,
    pins,
    feedback: feedback || "",
    buildCount: 0,
    ownerAccountId: ownerAccountId || null,
    ownerUsername: ownerUsername || null,
    createdAt: now,
    updatedAt: now
  };

  state.devices[device.id] = device;
  state.devicePblIndex[pblId] = device.id;

  await writeState(state);

  return publicDevice(device);
}

async function getDeviceByPblId(pblId) {
  const state = await readState();
  const deviceId = state.devicePblIndex[pblId];

  if (!deviceId) {
    return null;
  }

  return state.devices[deviceId] || null;
}

async function listDevices(options = {}) {
  const state = await readState();
  const ownerAccountId = options.ownerAccountId || null;

  return Object.values(state.devices)
    .filter((device) => !ownerAccountId || device.ownerAccountId === ownerAccountId)
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .map(publicDevice);
}

async function incrementDeviceBuildCount(pblId) {
  const state = await readState();
  const deviceId = state.devicePblIndex[pblId];

  if (!deviceId || !state.devices[deviceId]) {
    return null;
  }

  const device = state.devices[deviceId];
  device.buildCount = (device.buildCount || 0) + 1;
  device.updatedAt = new Date().toISOString();
  state.devices[deviceId] = device;

  await writeState(state);

  return publicDevice(device);
}

async function updateDeviceFeedback(pblId, feedback) {
  const state = await readState();
  const deviceId = state.devicePblIndex[pblId];

  if (!deviceId || !state.devices[deviceId]) {
    return null;
  }

  const device = state.devices[deviceId];
  device.feedback = feedback || "";
  device.updatedAt = new Date().toISOString();
  state.devices[deviceId] = device;

  await writeState(state);

  return publicDevice(device);
}

async function createCallSession({
  phoneNumber,
  pin,
  esp32Id,
  ownerAccountId,
  ownerUsername,
  devicePblId,
  deviceLabel
}) {
  const state = await readState();
  const now = new Date().toISOString();
  const { salt, hash } = hashSecret(pin);
  const user = {
    id: randomUUID(),
    phoneNumber,
    esp32Id,
    devicePblId: devicePblId || null,
    deviceLabel: deviceLabel || null,
    ownerAccountId: ownerAccountId || null,
    ownerUsername: ownerUsername || null,
    pinSalt: salt,
    pinHash: hash,
    createdAt: now,
    updatedAt: now,
    lastCallSid: null,
    buildRequest: null,
    buildStatus: null,
    buildError: null,
    buildPlan: null,
    currentStepIndex: 0,
    otaStatus: null
  };

  state.users[user.id] = user;
  state.phoneIndex[phoneNumber] = user.id;

  if (esp32Id) {
    state.deviceIndex[esp32Id] = user.id;
  }

  await writeState(state);

  return publicUser(user);
}

async function getUser(userId) {
  const state = await readState();
  return state.users[userId] || null;
}

async function setLastCallSid(userId, callSid) {
  const state = await readState();
  const user = state.users[userId];

  if (!user) {
    return null;
  }

  user.lastCallSid = callSid;
  user.updatedAt = new Date().toISOString();
  state.users[userId] = user;

  await writeState(state);

  return publicUser(user);
}

async function updateUser(userId, updater) {
  const state = await readState();
  const existingUser = state.users[userId];

  if (!existingUser) {
    return null;
  }

  const nextUser = updater({ ...existingUser }) || existingUser;
  nextUser.updatedAt = new Date().toISOString();
  state.users[userId] = nextUser;

  if (
    existingUser.phoneNumber &&
    existingUser.phoneNumber !== nextUser.phoneNumber &&
    state.phoneIndex[existingUser.phoneNumber] === userId
  ) {
    delete state.phoneIndex[existingUser.phoneNumber];
  }

  state.phoneIndex[nextUser.phoneNumber] = userId;

  if (
    existingUser.esp32Id &&
    existingUser.esp32Id !== nextUser.esp32Id &&
    state.deviceIndex[existingUser.esp32Id] === userId
  ) {
    delete state.deviceIndex[existingUser.esp32Id];
  }

  if (nextUser.esp32Id) {
    state.deviceIndex[nextUser.esp32Id] = userId;
  }

  await writeState(state);

  return publicUser(nextUser);
}

async function getUserByDeviceId(esp32Id) {
  const state = await readState();
  const userId = state.deviceIndex[esp32Id];

  if (!userId) {
    return null;
  }

  return state.users[userId] || null;
}

async function listUsers(limit = 20, options = {}) {
  const state = await readState();
  const ownerAccountId = options.ownerAccountId || null;

  return Object.values(state.users)
    .filter((user) => !ownerAccountId || user.ownerAccountId === ownerAccountId)
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, Math.max(0, limit))
    .map(publicUser);
}

function verifyPin(pin, user) {
  return verifySecret(pin, user.pinSalt, user.pinHash);
}

module.exports = {
  createAccount,
  createCallSession,
  createDevice,
  getAccount,
  getAccountByUsername,
  getDeviceByPblId,
  getUser,
  getUserByDeviceId,
  incrementDeviceBuildCount,
  listAccounts,
  listDevices,
  listUsers,
  setLastCallSid,
  updateUser,
  updateDeviceFeedback,
  verifyAccountPassword,
  verifyPin
};
