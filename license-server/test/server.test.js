import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { createLicenseServer } from "../server.js";

const adminToken = "test-admin-token-with-at-least-32-characters";
let dataDirectory;
let dataFile;
let server;
let baseUrl;

async function startServer() {
  server = await createLicenseServer({ adminToken, dataFile });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(path, { method = "GET", body, admin = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(admin ? { Authorization: `Bearer ${adminToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "domain-license-test-"));
  dataFile = join(dataDirectory, "licenses.json");
  await startServer();
});

after(async () => {
  await stopServer();
  await rm(dataDirectory, { recursive: true, force: true });
});

test("admin creates a license, device activates, and verification reflects revocation", async () => {
  const created = await request("/v1/admin/licenses", {
    method: "POST",
    admin: true,
    body: { maxDevices: 1, note: "test customer" },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.key, /^DH-[A-F0-9]{32}$/);

  const deviceId = "test-device-00000001";
  const activated = await request("/v1/activate", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.valid, true);

  const verified = await request("/v1/verify", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);

  const secondDevice = await request("/v1/activate", {
    method: "POST",
    body: { key: created.body.key, deviceId: "test-device-00000002" },
  });
  assert.equal(secondDevice.status, 409);
  assert.equal(secondDevice.body.code, "DEVICE_LIMIT_REACHED");

  const revoked = await request(`/v1/admin/licenses/${created.body.license.id}/revoke`, {
    method: "POST",
    admin: true,
  });
  assert.equal(revoked.body.status, "revoked");

  const denied = await request("/v1/verify", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "LICENSE_REVOKED");

  await stopServer();
  await startServer();
  const licenses = await request("/v1/admin/licenses", { admin: true });
  assert.equal(licenses.body[0].status, "revoked");
});

test("admin endpoints reject missing credentials and malformed license input", async () => {
  const unauthorized = await request("/v1/admin/licenses", { method: "POST", body: {} });
  assert.equal(unauthorized.status, 401);

  const invalid = await request("/v1/activate", {
    method: "POST",
    body: { key: "not-a-license", deviceId: "test-device-00000001" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_LICENSE_KEY");
});

test("admin can release a device activation after a device is replaced", async () => {
  const created = await request("/v1/admin/licenses", {
    method: "POST",
    admin: true,
    body: { maxDevices: 1 },
  });
  const firstDevice = await request("/v1/activate", {
    method: "POST",
    body: { key: created.body.key, deviceId: "test-device-00000001" },
  });
  assert.equal(firstDevice.status, 200);

  const reset = await request(
    `/v1/admin/licenses/${created.body.license.id}/reset-devices`,
    { method: "POST", admin: true },
  );
  assert.equal(reset.body.releasedDevices, 1);

  const replacementDevice = await request("/v1/activate", {
    method: "POST",
    body: { key: created.body.key, deviceId: "test-device-00000002" },
  });
  assert.equal(replacementDevice.status, 200);
});

test("admin can suspend, resume, soft-delete, and restore a license", async () => {
  const created = await request("/v1/admin/licenses", {
    method: "POST",
    admin: true,
    body: { maxDevices: 1, note: "customer to manage" },
  });
  const deviceId = "test-device-00000001";
  await request("/v1/activate", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });

  const suspended = await request(
    `/v1/admin/licenses/${created.body.license.id}/suspend`,
    { method: "POST", admin: true },
  );
  assert.equal(suspended.body.status, "suspended");
  const deniedWhileSuspended = await request("/v1/verify", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });
  assert.equal(deniedWhileSuspended.body.code, "LICENSE_SUSPENDED");

  const resumed = await request(
    `/v1/admin/licenses/${created.body.license.id}/resume`,
    { method: "POST", admin: true },
  );
  assert.equal(resumed.body.status, "active");
  assert.equal(
    (await request("/v1/verify", {
      method: "POST",
      body: { key: created.body.key, deviceId },
    })).body.valid,
    true,
  );

  const deleted = await request(
    `/v1/admin/licenses/${created.body.license.id}/delete`,
    { method: "POST", admin: true },
  );
  assert.equal(deleted.body.status, "deleted");
  const deniedAfterDelete = await request("/v1/verify", {
    method: "POST",
    body: { key: created.body.key, deviceId },
  });
  assert.equal(deniedAfterDelete.body.code, "LICENSE_REVOKED");

  const restored = await request(
    `/v1/admin/licenses/${created.body.license.id}/restore`,
    { method: "POST", admin: true },
  );
  assert.equal(restored.body.status, "active");
  assert.equal(
    (await request("/v1/verify", {
      method: "POST",
      body: { key: created.body.key, deviceId },
    })).body.valid,
    true,
  );
});

test("admin dashboard is served with restrictive security headers", async () => {
  const response = await fetch(`${baseUrl}/admin`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await response.text(), /Quản lý license/);
});

test("extension background activates and rechecks a key through the license API", async () => {
  const created = await request("/v1/admin/licenses", {
    method: "POST",
    admin: true,
    body: { maxDevices: 1 },
  });
  const values = new Map();
  let messageListener;
  const chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: values.get(key) };
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) values.set(key, value);
        },
        async remove(key) {
          values.delete(key);
        },
      },
    },
  };
  const backgroundSource = await readFile(
    new URL("../../license-background.js", import.meta.url),
    "utf8",
  );
  runInNewContext(backgroundSource, {
    chrome,
    crypto: webcrypto,
    fetch,
    DOMAIN_LICENSE_CONFIG: { apiBaseUrl: baseUrl },
  });

  async function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const keepChannelOpen = messageListener(
        message,
        {
          id: "test-extension-id",
          url: "chrome-extension://test-extension-id/manage.html",
        },
        resolve,
      );
      if (keepChannelOpen !== true) reject(new Error("License message was not handled."));
    });
  }

  const activated = await sendMessage({
    type: "license:activate",
    key: created.body.key,
  });
  assert.equal(activated.valid, true);

  const verified = await sendMessage({ type: "license:check" });
  assert.equal(verified.valid, true);

  const revoked = await request(`/v1/admin/licenses/${created.body.license.id}/revoke`, {
    method: "POST",
    admin: true,
  });
  assert.equal(revoked.body.status, "revoked");

  const denied = await sendMessage({ type: "license:check" });
  assert.equal(denied.valid, false);
  assert.equal(denied.code, "LICENSE_REVOKED");
});
