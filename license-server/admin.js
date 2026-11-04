let adminToken = "";

const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const message = document.querySelector("#message");
const tokenInput = document.querySelector("#admin-token");
const licenseList = document.querySelector("#license-list");
const newKeyPanel = document.querySelector("#new-key");
const newKeyValue = document.querySelector("#new-key-value");

function showMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle("success", success);
  message.hidden = !text;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Máy chủ trả về phản hồi không hợp lệ.");
  }

  if (response.status === 401) {
    adminToken = "";
    dashboard.hidden = true;
    loginPanel.hidden = false;
    throw new Error("Admin token không đúng hoặc đã hết hiệu lực.");
  }
  if (!response.ok) {
    throw new Error(result.message || `Yêu cầu thất bại (${response.status}).`);
  }
  return result;
}

function formatDate(value) {
  if (!value) return "Không hết hạn";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Không rõ" : date.toLocaleString("vi-VN");
}

function statusName(status) {
  return ({
    active: "Đang hoạt động",
    suspended: "Tạm khóa",
    expired: "Hết hạn",
    deleted: "Đã xóa mềm",
    revoked: "Đã thu hồi",
  })[status] || status;
}

function addAction(container, label, action, license, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${options.danger ? "danger" : "secondary"}`;
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (options.confirm && !window.confirm(options.confirm)) return;
    button.disabled = true;
    showMessage("");
    try {
      const result = await api(`/v1/admin/licenses/${license.id}/${action}`, {
        method: "POST",
      });
      await loadLicenses();
      showMessage(`Đã cập nhật license: ${statusName(result.status)}.`, true);
    } catch (error) {
      showMessage(error.message);
      button.disabled = false;
    }
  });
  container.append(button);
}

function renderLicense(license) {
  const card = document.createElement("article");
  card.className = "license-card";

  const top = document.createElement("div");
  top.className = "license-top";
  const identity = document.createElement("div");
  const name = document.createElement("p");
  name.className = "license-name";
  name.textContent = license.note || "Chưa ghi tên khách";
  const key = document.createElement("div");
  key.className = "license-id";
  key.textContent = `Key kết thúc bằng ${license.keyLast4} · ID ${license.id}`;
  identity.append(name, key);

  const status = document.createElement("span");
  status.className = `status status-${license.status}`;
  status.textContent = statusName(license.status);
  top.append(identity, status);

  const meta = document.createElement("div");
  meta.className = "license-meta";
  const created = document.createElement("span");
  created.textContent = `Tạo: ${formatDate(license.createdAt)}`;
  const expiry = document.createElement("span");
  expiry.textContent = `Hết hạn: ${formatDate(license.expiresAt)}`;
  const devices = document.createElement("span");
  devices.textContent = `Thiết bị: ${license.deviceCount}/${license.maxDevices}`;
  meta.append(created, expiry, devices);

  const actions = document.createElement("div");
  actions.className = "license-actions";
  if (license.status === "active" || license.status === "expired") {
    addAction(actions, "Tạm khóa", "suspend", license);
    addAction(actions, "Xóa mềm", "delete", license, {
      danger: true,
      confirm: "License sẽ bị chặn ngay nhưng hồ sơ vẫn được giữ để tra cứu. Tiếp tục?",
    });
  } else if (license.status === "suspended") {
    addAction(actions, "Mở lại", "resume", license);
    addAction(actions, "Xóa mềm", "delete", license, {
      danger: true,
      confirm: "License sẽ bị chặn và đánh dấu xóa mềm. Tiếp tục?",
    });
  } else if (license.status === "deleted" || license.status === "revoked") {
    addAction(actions, "Khôi phục", "restore", license);
  }

  card.append(top, meta, actions);
  return card;
}

async function loadLicenses() {
  const licenses = await api("/v1/admin/licenses");
  licenseList.replaceChildren();
  if (licenses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Chưa có license nào.";
    licenseList.append(empty);
  } else {
    for (const license of licenses) licenseList.append(renderLicense(license));
  }
  loginPanel.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#logout").hidden = false;
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  adminToken = tokenInput.value.trim();
  tokenInput.value = "";
  showMessage("");
  try {
    await loadLicenses();
  } catch (error) {
    adminToken = "";
    showMessage(error.message);
  }
});

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");
  const note = document.querySelector("#customer-note").value.trim();
  const maxDevices = Number(document.querySelector("#max-devices").value);
  try {
    const created = await api("/v1/admin/licenses", {
      method: "POST",
      body: JSON.stringify({ note, maxDevices }),
    });
    newKeyValue.textContent = created.key;
    newKeyPanel.hidden = false;
    await loadLicenses();
    showMessage("Đã tạo license. Hãy sao chép key và lưu lại; key đầy đủ sẽ không thể xem lại.", true);
  } catch (error) {
    showMessage(error.message);
  }
});

document.querySelector("#copy-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(newKeyValue.textContent);
    showMessage("Đã sao chép key mới.", true);
  } catch {
    showMessage("Không sao chép tự động được. Hãy chọn và sao chép key hiển thị.");
  }
});

document.querySelector("#refresh").addEventListener("click", async () => {
  showMessage("");
  try {
    await loadLicenses();
  } catch (error) {
    showMessage(error.message);
  }
});

document.querySelector("#logout").addEventListener("click", () => {
  adminToken = "";
  licenseList.replaceChildren();
  newKeyPanel.hidden = true;
  dashboard.hidden = true;
  loginPanel.hidden = false;
  document.querySelector("#logout").hidden = true;
  showMessage("");
});
