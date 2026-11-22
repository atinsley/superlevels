// Paperless-ngx client, shared by the popup (settings + connection test) and the screenshot
// preview (Send to Paperless). Uses the REST API with an API token.
//
// Requests omit cookies on purpose: if you are also logged in to Paperless in this browser,
// the session cookie would make Paperless (Django REST framework) treat the request as a
// session login and reject the upload with "CSRF Failed".
const Paperless = {
  async config() {
    const d = await chrome.storage.local.get(["paperless_url", "paperless_token"]);
    return d.paperless_url && d.paperless_token ? { url: d.paperless_url, token: d.paperless_token } : null;
  },

  // "paperless.example.com/" -> "https://paperless.example.com"; also drops a trailing /api
  normalizeUrl(raw) {
    let u = (raw || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u.replace(/\/+$/, "").replace(/\/api$/i, "");
  },

  async request(cfg, path, init = {}) {
    let res;
    try {
      res = await fetch(cfg.url + path, {
        ...init,
        credentials: "omit",
        headers: { ...(init.headers || {}), Authorization: `Token ${cfg.token}`, Accept: "application/json" },
      });
    } catch {
      throw new Error(`Can't reach Paperless at ${cfg.url}.`);
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Paperless refused the API token (${data?.detail || "HTTP " + res.status}).`);
    }
    if (!res.ok) {
      const detail = data?.detail || (data && JSON.stringify(data)) || `HTTP ${res.status}`;
      throw new Error(`Paperless: ${detail}`);
    }
    return data;
  },

  // Checks the URL and token; returns how many documents Paperless has
  async test(cfg) {
    const d = await this.request(cfg, "/api/documents/?page_size=1");
    if (typeof d?.count !== "number") throw new Error("That address answered, but not like Paperless does.");
    return d.count;
  },

  // Uploads a file; returns the task id Paperless gives back
  async upload(cfg, blob, fileName, title) {
    const form = new FormData();
    form.append("document", blob, fileName);
    if (title) form.append("title", title.slice(0, 128));
    const task = await this.request(cfg, "/api/documents/post_document/", { method: "POST", body: form });
    const id = typeof task === "string" ? task : task?.task_id;
    if (!id) throw new Error("Paperless accepted the upload but sent no task id.");
    return id;
  },

  // Waits for Paperless to finish consuming the upload.
  // Returns { docId } on success, { pending: true } if it is still working after timeoutMs.
  async waitForTask(cfg, taskId, { timeoutMs = 90000, intervalMs = 1500, onStatus } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const list = await this.request(cfg, `/api/tasks/?task_id=${encodeURIComponent(taskId)}`);
      const t = Array.isArray(list) ? list[0] : list?.results?.[0];
      if (t) {
        if (onStatus) onStatus(t.status);
        if (t.status === "SUCCESS") return { docId: t.related_document || null };
        if (t.status === "FAILURE" || t.status === "REVOKED") {
          throw new Error(`Paperless couldn't add it: ${t.result || t.status}`);
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { pending: true };
  },

  docUrl(cfg, id) {
    return `${cfg.url}/documents/${id}/details`;
  },
};
