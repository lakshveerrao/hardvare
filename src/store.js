const fs = require("fs/promises");
const path = require("path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("crypto");
const { config } = require("./config");

const defaultState = {
  users: {},
  phoneIndex: {},
  deviceIndex: {}
};

let writeQueue = Promise.resolve();

async function ensureStoreFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });

  try {
    await fs.access(config.dataFile);
  } catch {
    await fs.writeFile(
      config.dataFile,
      JSON.stringify(defaultState, null, 2),
      "utf8"
    );
  }
}

async function readState() {
  await ensureStoreFile();
  const raw = await fs.readFile(config.dataFile, "utf8");

  if (!raw.trim()) {
    return { ...defaultState };
  }

  const parsed = JSON.parse(raw);

  return {
    users: parsed.users || {},
    phoneIndex: parsed.phoneIndex || {},
    deviceIndex: parsed.deviceIndex || {}
  };
}

function writeState(state) {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(config.dataFile, JSON.stringify(state, null, 2), "utf8")
  );

  return writeQueue;
}

function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 64).toString("hex");

  return { salt, hash };
}

function verifyPin(pin, user) {
  const expected = Buffer.from(user.pinHash, "hex");
  const actual = Buffer.from(scryptSync(pin, user.pinSalt, 64).toString("hex"), "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    esp32Id: user.esp32Id || null,
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

async function upsertUser({ phoneNumber, pin, esp32Id }) {
  const state = await readState();
  const existingUserId = state.phoneIndex[phoneNumber];
  const now = new Date().toISOString();
  const user =
    (existingUserId && state.users[existingUserId]) || {
      id: randomUUID(),
      phoneNumber,
      createdAt: now
    };

  const { salt, hash } = hashPin(pin);
  user.phoneNumber = phoneNumber;
  user.esp32Id = esp32Id;
  user.pinSalt = salt;
  user.pinHash = hash;
  user.updatedAt = now;
  user.lastCallSid = user.lastCallSid || null;
  user.buildRequest = user.buildRequest || null;
  user.buildStatus = user.buildStatus || null;
  user.buildError = user.buildError || null;
  user.buildPlan = user.buildPlan || null;
  user.currentStepIndex = user.currentStepIndex || 0;
  user.otaStatus = user.otaStatus || null;

  state.users[user.id] = user;
  state.phoneIndex[phoneNumber] = user.id;
  state.deviceIndex[esp32Id] = user.id;

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
  state.phoneIndex[nextUser.phoneNumber] = userId;

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

async function listUsers(limit = 20) {
  const state = await readState();

  return Object.values(state.users)
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, Math.max(0, limit))
    .map(publicUser);
}

module.exports = {
  getUser,
  getUserByDeviceId,
  listUsers,
  setLastCallSid,
  updateUser,
  upsertUser,
  verifyPin
};
