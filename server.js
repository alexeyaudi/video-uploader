import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Переменные окружения -------------------------------------------------
// Из бакета Railway (Variable Reference): ENDPOINT, BUCKET, ACCESS_KEY_ID,
// SECRET_ACCESS_KEY, REGION
const {
  ENDPOINT,
  BUCKET,
  ACCESS_KEY_ID,
  SECRET_ACCESS_KEY,
  REGION = "auto",
  N8N_WEBHOOK_URL,      // Production URL webhook в n8n
  PORT = "3000",
} = process.env;

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_CONTENT_BOT_TOKEN;

const MAX_MB = Number(process.env.MAX_MB || 500);        // лимит размера файла
const TTL_HOURS = Number(process.env.TTL_HOURS || 24);   // срок хранения файла
const LINK_HOURS = Number(process.env.LINK_HOURS || 6);  // срок жизни ссылки для модели
const INITDATA_MAX_AGE_SEC = 60 * 60;                    // initData не старше часа
const PREFIX = "videos/";


for (const [k, v] of Object.entries({
  ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, BOT_TOKEN, N8N_WEBHOOK_URL,
})) {
  if (!v) {
    console.error(`Не задана переменная окружения: ${k}`);
    process.exit(1);
  }
}

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
});

// ---- Проверка подписи Telegram Mini App (initData) ------------------------
function validateInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(calc, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > INITDATA_MAX_AGE_SEC) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

// ---- Приложение -----------------------------------------------------------
const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

// Загрузка: тело запроса = сам файл (поток), без буферизации в памяти
app.put("/api/upload", async (req, res) => {
  try {
    const user = validateInitData(req.header("x-init-data"));
    if (!user?.id) return res.status(401).json({ ok: false, error: "unauthorized" });

    let resumeUrl = N8N_WEBHOOK_URL;
    const resumeHeader = req.header("x-resume-url");
    if (resumeHeader) {
      try {
        const decoded = decodeURIComponent(resumeHeader);
        if (new URL(decoded).origin !== new URL(N8N_WEBHOOK_URL).origin) throw new Error("bad origin");
        resumeUrl = decoded;
      } catch {
        return res.status(400).json({ ok: false, error: "Некорректная ссылка возобновления" });
      }
    }
    
    const size = Number(req.header("content-length") || 0);
    if (size && size > MAX_MB * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: `Файл больше ${MAX_MB} МБ` });
    }

    const contentType = req.header("content-type") || "video/mp4";
    if (!contentType.startsWith("video/")) {
      return res.status(415).json({ ok: false, error: "Нужен видеофайл" });
    }

    const originalName = decodeURIComponent(req.header("x-file-name") || "video.mp4");
    const ext = (path.extname(originalName) || ".mp4").toLowerCase().slice(0, 8);
    const key = `${PREFIX}${user.id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

    let uploaded = 0;
    req.on("data", (c) => {
      uploaded += c.length;
      if (uploaded > MAX_MB * 1024 * 1024) req.destroy(new Error("too large"));
    });

    await new Upload({
      client: s3,
      params: { Bucket: BUCKET, Key: key, Body: req, ContentType: contentType },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    }).done();

    const videoUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: LINK_HOURS * 3600 }
    );

  const resp = await fetch(resumeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: user.id,
        user,
        video_url: videoUrl,
        key,
        file_name: originalName,
        mime_type: contentType,
        size_bytes: uploaded,
      }),
    });
    if (!resp.ok) throw new Error(`n8n вернул ${resp.status}`);

    res.json({ ok: true });
  } catch (e) {
    console.error("upload error:", e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Ошибка загрузки" });
  }
});

// ---- Очистка старых файлов (в бакете Railway нет lifecycle-правил) --------
async function cleanup() {
  try {
    const cutoff = Date.now() - TTL_HOURS * 3600 * 1000;
    let token;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token })
      );
      const old = (list.Contents || [])
        .filter((o) => o.LastModified && o.LastModified.getTime() < cutoff)
        .map((o) => ({ Key: o.Key }));
      if (old.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: old } }));
        console.log(`cleanup: удалено ${old.length}`);
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    console.error("cleanup error:", e);
  }
}
setInterval(cleanup, 30 * 60 * 1000);
cleanup();

app.listen(Number(PORT), () => console.log(`uploader on :${PORT}`));
