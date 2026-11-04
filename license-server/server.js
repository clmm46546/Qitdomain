import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultDataFile = resolve(dirname(fileURLToPath(import.meta.url)), "data", "licenses.json");
const maxRequestBytes = 16 * 1024;
const licenseKeyPattern = /^DH-[A-F0-9]{32}$/;
const deviceIdPattern = /^[A-Za-z0-9._:-]{16,128}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải có Content-Type application/json.");
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxRequestBytes) {
      throw new HttpError(413, "REQUEST_TOO_LARGE", "Dữ liệu gửi lên quá lớn.");
    }
    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected an object");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
  }
}

function requireLicenseInput(body) {
  const key = typeof body.key === "string" ? body.key.trim().toUpperCase() : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!licenseKeyPattern.test(key)) {
    throw new HttpError(400, "INVALID_LICENSE_KEY", "License key không đúng định dạng.");
  }
  if (!deviceIdPattern.test(deviceId)) {
    throw new HttpError(400, "INVALID_DEVICE_ID", "Mã thiết bị không hợp lệ.");
  }
  return { key, deviceId };
}

function publicLicenseResult(license, deviceId) {
  if (!license || license.status !== "active") {
    throw new HttpError(403, "LICENSE_REVOKED", "License không hoạt động hoặc đã bị thu hồi.");
  }
  if (license.expiresAt && Date.parse(license.expiresAt) <= Date.now()) {
    throw new HttpError(403, "LICENSE_EXPIRED", "License đã hết hạn.");
  }
  if (!license.devices[deviceId]) {
    throw new HttpError(403, "DEVICE_NOT_ACTIVATED", "Thiết bị chưa được kích hoạt license này.");
  }
  return { valid: true, expiresAt: license.expiresAt };
}

export async function createLicenseServer({ adminToken, dataFile = defaultDataFile } = {}) {
  if (typeof adminToken !== "string" || Buffer.byteLength(adminToken) < 32) {
    throw new Error("LICENSE_ADMIN_TOKEN must contain at least 32 bytes.");
  }

  const resolvedDataFile = resolve(dataFile);
  await mkdir(dirname(resolvedDataFile), { recursive: true });

  let database;
  try {
    database = JSON.parse(await readFile(resolvedDataFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    database = { version: 1, licenses: [] };
  }
  if (
    database?.version !== 1 ||
    !Array.isArray(database.licenses) ||
    database.licenses.some(
      (license) =>
        typeof license?.id !== "string" ||
        typeof license?.keyHash !== "string" ||
        !license?.devices ||
        typeof license.devices !== "object",
    )
  ) {
    throw new Error("License database has an unsupported or invalid format.");
  }

  let writeQueue = Promise.resolve();
  async function persist() {
    const contents = JSON.stringify(database, null, 2) + "\n";
    const temporaryFile = `${resolvedDataFile}.${randomUUID()}.tmp`;
    writeQueue = writeQueue.then(async () => {
      await writeFile(temporaryFile, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryFile, resolvedDataFile);
    });
    return writeQueue;
  }

  function requireAdmin(request) {
    const authorization = request.headers.authorization ?? "";
    const prefix = "Bearer ";
    const supplied = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
    const expectedBytes = Buffer.from(adminToken);
    const suppliedBytes = Buffer.from(supplied);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new HttpError(401, "ADMIN_UNAUTHORIZED", "Cần thông tin quản trị hợp lệ.");
    }
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname.startsWith("/v1/admin/")) {
      requireAdmin(request);
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/licenses") {
      const body = await readJsonBody(request);
      const expiresAt = body.expiresAt ?? null;
      if (
        expiresAt !== null &&
        (typeof expiresAt !== "string" ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.now())
      ) {
        throw new HttpError(400, "INVALID_EXPIRY", "Ngày hết hạn phải là thời điểm hợp lệ trong tương lai.");
      }
      const maxDevices = body.maxDevices ?? 1;
      if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) {
        throw new HttpError(400, "INVALID_DEVICE_LIMIT", "Giới hạn thiết bị phải từ 1 đến 100.");
      }
      const note = body.note ?? "";
      if (typeof note !== "string" || note.length > 250) {
        throw new HttpError(400, "INVALID_NOTE", "Ghi chú không được vượt quá 250 ký tự.");
      }

      const key = `DH-${randomBytes(16).toString("hex").toUpperCase()}`;
      const license = {
        id: randomUUID(),
        keyHash: hashKey(key),
        keyLast4: key.slice(-4),
        status: "active",
        createdAt: new Date().toISOString(),
        expiresAt,
        maxDevices,
        note,
        devices: {},
      };
      database.licenses.push(license);
      await persist();
      return sendJson(response, 201, {
        key,
        license: {
          id: license.id,
          keyLast4: license.keyLast4,
          status: license.status,
          createdAt: license.createdAt,
          expiresAt: license.expiresAt,
          maxDevices: license.maxDevices,
          note: license.note,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/licenses") {
      return sendJson(
        response,
        200,
        database.licenses.map((license) => ({
          id: license.id,
          keyLast4: license.keyLast4,
          status:
            license.status === "active" &&
            license.expiresAt &&
            Date.parse(license.expiresAt) <= Date.now()
              ? "expired"
              : license.status,
          createdAt: license.createdAt,
          expiresAt: license.expiresAt,
          maxDevices: license.maxDevices,
          deviceCount: Object.keys(license.devices).length,
          note: license.note,
        })),
      );
    }

    const revokeMatch = url.pathname.match(/^\/v1\/admin\/licenses\/([0-9a-f-]{36})\/revoke$/i);
    if (request.method === "POST" && revokeMatch) {
      const license = database.licenses.find((entry) => entry.id === revokeMatch[1]);
      if (!license) throw new HttpError(404, "LICENSE_NOT_FOUND", "Không tìm thấy license.");
      license.status = "revoked";
      license.revokedAt = new Date().toISOString();
      await persist();
      return sendJson(response, 200, { ok: true, id: license.id, status: license.status });
    }

    const resetDevicesMatch = url.pathname.match(
      /^\/v1\/admin\/licenses\/([0-9a-f-]{36})\/reset-devices$/i,
    );
    if (request.method === "POST" && resetDevicesMatch) {
      const license = database.licenses.find((entry) => entry.id === resetDevicesMatch[1]);
      if (!license) throw new HttpError(404, "LICENSE_NOT_FOUND", "Không tìm thấy license.");
      const releasedDevices = Object.keys(license.devices).length;
      license.devices = {};
      await persist();
      return sendJson(response, 200, { ok: true, id: license.id, releasedDevices });
    }

    if (request.method === "POST" && url.pathname === "/v1/activate") {
      const { key, deviceId } = requireLicenseInput(await readJsonBody(request));
      const license = database.licenses.find((entry) => entry.keyHash === hashKey(key));
      if (!license || license.status !== "active") {
        throw new HttpError(403, "LICENSE_INVALID", "License không hợp lệ hoặc đã bị thu hồi.");
      }
      if (license.expiresAt && Date.parse(license.expiresAt) <= Date.now()) {
        throw new HttpError(403, "LICENSE_EXPIRED", "License đã hết hạn.");
      }
      if (!license.devices[deviceId] && Object.keys(license.devices).length >= license.maxDevices) {
        throw new HttpError(409, "DEVICE_LIMIT_REACHED", "License đã đạt giới hạn thiết bị.");
      }
      if (!license.devices[deviceId]) {
        license.devices[deviceId] = { activatedAt: new Date().toISOString() };
        await persist();
      }
      return sendJson(response, 200, { valid: true, expiresAt: license.expiresAt });
    }

    if (request.method === "POST" && url.pathname === "/v1/verify") {
      const { key, deviceId } = requireLicenseInput(await readJsonBody(request));
      const license = database.licenses.find((entry) => entry.keyHash === hashKey(key));
      return sendJson(response, 200, publicLicenseResult(license, deviceId));
    }

    throw new HttpError(404, "NOT_FOUND", "Không tìm thấy API.");
  }

  return createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("License server error:", error);
      sendJson(response, status, {
        valid: false,
        code: error.code ?? "INTERNAL_ERROR",
        message: error instanceof HttpError ? error.message : "Lỗi máy chủ license.",
      });
    });
  });
}

async function main() {
  const server = await createLicenseServer({
    adminToken: process.env.LICENSE_ADMIN_TOKEN,
    dataFile: process.env.LICENSE_DATA_FILE || defaultDataFile,
  });
  const port = Number(process.env.PORT || 8787);
  const host = process.env.LICENSE_HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  server.listen(port, host, () => {
    const address = server.address();
    console.log(`License server listening on ${host}:${address.port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
