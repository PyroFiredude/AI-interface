const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const OpenAI = require("openai");

require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const keyFilePath = path.join(__dirname, "key.txt");
const imagesDir = path.join(__dirname, "images");
const conversationsDir = path.join(__dirname, "conversations");
const imageMetaFilePath = path.join(imagesDir, "meta.json");
const legacySpendFilePath = path.join(__dirname, "spend.json");
const runtimeDataDir = path.join(process.env.LOCALAPPDATA || process.env.TEMP || __dirname, "VibeImageBuilder");
const spendFilePath = path.join(runtimeDataDir, "spend.json");
const sessionStartedAt = new Date().toISOString();

const usdToGbpRate = Number.parseFloat(process.env.OPENAI_USD_TO_GBP || "0.79") || 0.79;
const pricing = {
  chatInputUsdPerMillion: Number.parseFloat(process.env.OPENAI_CHAT_INPUT_USD_PER_1M || "2.5") || 2.5,
  chatOutputUsdPerMillion: Number.parseFloat(process.env.OPENAI_CHAT_OUTPUT_USD_PER_1M || "15") || 15,
  imageTextInputUsdPerMillion: Number.parseFloat(process.env.OPENAI_IMAGE_TEXT_INPUT_USD_PER_1M || "5") || 5,
  imageImageInputUsdPerMillion: Number.parseFloat(process.env.OPENAI_IMAGE_INPUT_IMAGE_USD_PER_1M || "8") || 8,
  imageTextOutputUsdPerMillion: Number.parseFloat(process.env.OPENAI_IMAGE_TEXT_OUTPUT_USD_PER_1M || "0") || 0,
  imageImageOutputUsdPerMillion: Number.parseFloat(process.env.OPENAI_IMAGE_OUTPUT_IMAGE_USD_PER_1M || "30") || 30
};

let sessionSpendUsd = 0;
let modelListCache = {
  expiresAt: 0,
  chatModels: [],
  imageModels: []
};

if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

if (!fs.existsSync(conversationsDir)) {
  fs.mkdirSync(conversationsDir, { recursive: true });
}

if (!fs.existsSync(runtimeDataDir)) {
  fs.mkdirSync(runtimeDataDir, { recursive: true });
}

if (!fs.existsSync(imageMetaFilePath)) {
  fs.writeFileSync(imageMetaFilePath, JSON.stringify({}, null, 2));
}

if (!fs.existsSync(spendFilePath)) {
  if (fs.existsSync(legacySpendFilePath)) {
    fs.copyFileSync(legacySpendFilePath, spendFilePath);
  } else {
    fs.writeFileSync(spendFilePath, JSON.stringify({ months: {} }, null, 2));
  }
}

let apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  try {
    if (fs.existsSync(keyFilePath)) {
      apiKey = fs.readFileSync(keyFilePath, "utf8").trim();
    }
  } catch (error) {
    console.warn("Failed to read key.txt:", error.message);
  }
}

if (!apiKey) {
  console.warn("No API key found in OPENAI_API_KEY or key.txt. API calls will fail until configured.");
}

const client = apiKey ? new OpenAI({ apiKey }) : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(imagesDir));

function extractAssistantText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const outputItems = Array.isArray(response?.output) ? response.output : [];

  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];

    for (const content of contentItems) {
      if (content?.type === "output_text" && typeof content?.text === "string" && content.text.trim()) {
        return content.text.trim();
      }

      if (content?.type === "refusal" && typeof content?.refusal === "string" && content.refusal.trim()) {
        return content.refusal.trim();
      }
    }
  }

  return "I could not generate a response.";
}

function createImageFilename(prompt) {
  const base = String(prompt || "image")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${base}-${suffix}.png`;
}

function isValidConversationId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
}

function getConversationFilePath(id) {
  return path.join(conversationsDir, `${id}.json`);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => {
      const normalized = {
        role: message?.role === "assistant" ? "assistant" : "user",
        content: String(message?.content || "")
      };

      if (typeof message?.imageRef === "string" && message.imageRef.trim()) {
        normalized.imageRef = message.imageRef.trim();
      }

      if (typeof message?.imagePrompt === "string" && message.imagePrompt.trim()) {
        normalized.imagePrompt = message.imagePrompt.trim();
      }

      if (typeof message?.imageSize === "string" && message.imageSize.trim()) {
        normalized.imageSize = message.imageSize.trim();
      }

      return normalized;
    })
    .filter((message) => message.content.trim() || message.imageRef);
}

function inferConversationTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "New Conversation";
  }

  return firstUserMessage.content.slice(0, 70) || "New Conversation";
}

function isSafeImageFileName(fileName) {
  if (typeof fileName !== "string") {
    return false;
  }

  const normalized = path.basename(fileName);
  if (normalized !== fileName) {
    return false;
  }

  return /\.(png|jpg|jpeg|webp)$/i.test(fileName);
}

async function readImageMeta() {
  try {
    const raw = await fs.promises.readFile(imageMetaFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeImageMeta(meta) {
  await fs.promises.writeFile(imageMetaFilePath, JSON.stringify(meta, null, 2));
}

async function updateImageMeta(fileName, updates) {
  const meta = await readImageMeta();
  meta[fileName] = {
    ...(meta[fileName] || {}),
    ...updates
  };
  await writeImageMeta(meta);
}

function costFromTokens(tokenCount, usdPerMillion) {
  if (!Number.isFinite(tokenCount) || !Number.isFinite(usdPerMillion) || tokenCount <= 0 || usdPerMillion <= 0) {
    return 0;
  }

  return (tokenCount / 1_000_000) * usdPerMillion;
}

function roundSpend(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function getCurrentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

async function readSpendData() {
  try {
    const raw = await fs.promises.readFile(spendFilePath, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return { months: {} };
    }

    if (!parsed.months || typeof parsed.months !== "object") {
      parsed.months = {};
    }

    return parsed;
  } catch {
    return { months: {} };
  }
}

async function writeSpendData(spendData) {
  await fs.promises.writeFile(spendFilePath, JSON.stringify(spendData, null, 2));
}

function calculateChatCostUsd(usage) {
  return roundSpend(
    costFromTokens(usage?.input_tokens || 0, pricing.chatInputUsdPerMillion) +
      costFromTokens(usage?.output_tokens || 0, pricing.chatOutputUsdPerMillion)
  );
}

function calculateImageCostUsd(usage) {
  const inputDetails = usage?.input_tokens_details || {};
  const outputDetails = usage?.output_tokens_details || {};

  return roundSpend(
    costFromTokens(inputDetails.text_tokens || 0, pricing.imageTextInputUsdPerMillion) +
      costFromTokens(inputDetails.image_tokens || 0, pricing.imageImageInputUsdPerMillion) +
      costFromTokens(outputDetails.text_tokens || 0, pricing.imageTextOutputUsdPerMillion) +
      costFromTokens(outputDetails.image_tokens || 0, pricing.imageImageOutputUsdPerMillion)
  );
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isImageModelId(modelId) {
  return /^(gpt-image|chatgpt-image|dall-e)/i.test(modelId);
}

function isChatModelId(modelId) {
  if (!modelId || isImageModelId(modelId)) {
    return false;
  }

  if (/^(gpt|chat|o\d)/i.test(modelId) === false) {
    return false;
  }

  return !/(audio|realtime|transcribe|tts|search-api|search-preview|whisper|computer-use)/i.test(modelId);
}

async function getAvailableModels() {
  const now = Date.now();
  if (modelListCache.expiresAt > now && modelListCache.chatModels.length && modelListCache.imageModels.length) {
    return modelListCache;
  }

  const defaultChatModel = process.env.OPENAI_CHAT_MODEL || "gpt-5";
  const defaultImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

  if (!client) {
    return {
      chatModels: [defaultChatModel],
      imageModels: [defaultImageModel],
      expiresAt: now + 5 * 60 * 1000
    };
  }

  const page = await client.models.list();
  const modelIds = Array.isArray(page?.data) ? page.data.map((model) => model.id) : [];

  const chatModels = uniqueSorted([...modelIds.filter(isChatModelId), defaultChatModel]);
  const imageModels = uniqueSorted([...modelIds.filter(isImageModelId), defaultImageModel]);

  modelListCache = {
    chatModels,
    imageModels,
    expiresAt: now + 5 * 60 * 1000
  };

  return modelListCache;
}

async function recordSpend(usdCost) {
  if (!Number.isFinite(usdCost) || usdCost <= 0) {
    return;
  }

  sessionSpendUsd = roundSpend(sessionSpendUsd + usdCost);

  const spendData = await readSpendData();
  const monthKey = getCurrentMonthKey();

  if (!spendData.months[monthKey]) {
    spendData.months[monthKey] = { usd: 0, updatedAt: null };
  }

  spendData.months[monthKey].usd = roundSpend((spendData.months[monthKey].usd || 0) + usdCost);
  spendData.months[monthKey].updatedAt = new Date().toISOString();

  await writeSpendData(spendData);
}

async function getSpendSummary() {
  const spendData = await readSpendData();
  const monthKey = getCurrentMonthKey();
  const monthUsd = Number(spendData.months?.[monthKey]?.usd || 0);

  return {
    estimated: true,
    currency: "GBP",
    usdToGbpRate,
    sessionStartedAt,
    currentMonth: monthKey,
    session: {
      usd: roundSpend(sessionSpendUsd),
      gbp: roundSpend(sessionSpendUsd * usdToGbpRate)
    },
    month: {
      usd: roundSpend(monthUsd),
      gbp: roundSpend(monthUsd * usdToGbpRate)
    }
  };
}

async function saveGeneratedImage(image, prompt, metadata = {}) {
  const fileName = createImageFilename(prompt);
  const filePath = path.join(imagesDir, fileName);

  if (image?.b64_json) {
    fs.writeFileSync(filePath, Buffer.from(image.b64_json, "base64"));
  } else if (image?.url) {
    const download = await fetch(image.url);

    if (!download.ok) {
      throw new Error(`Image download failed with status ${download.status}`);
    }

    const arrayBuffer = await download.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  } else {
    throw new Error("No image binary payload returned");
  }

  await updateImageMeta(fileName, metadata);

  return {
    fileName,
    savedPath: path.join("images", fileName)
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "API key is not configured" });
    }

    const { messages } = req.body;
    const requestedModel = typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : process.env.OPENAI_CHAT_MODEL || "gpt-5";

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }

    const response = await client.responses.create({
      model: requestedModel,
      input: messages.map((message) => ({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: String(message.content || "")
          }
        ]
      }))
    });

    const outputText = extractAssistantText(response);
    await recordSpend(calculateChatCostUsd(response?.usage));

    return res.json({
      outputText,
      model: response.model,
      requestedModel
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({
      error: error?.message || "Chat request failed"
    });
  }
});

app.post("/api/image", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "API key is not configured" });
    }

    const { prompt, size, sourceImageFileName } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    const imageModel = typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

    const normalizedSize = size || "1024x1024";

    if (sourceImageFileName) {
      if (!isSafeImageFileName(sourceImageFileName)) {
        return res.status(400).json({ error: "Invalid image file name" });
      }

      const sourceFilePath = path.join(imagesDir, sourceImageFileName);
      if (!fs.existsSync(sourceFilePath)) {
        return res.status(404).json({ error: "Source image not found" });
      }
    }

    const result = await client.images.generate({
      model: imageModel,
      prompt,
      size: normalizedSize
    });

    const image = result.data?.[0];

    if (!image) {
      return res.status(500).json({ error: "No image data returned" });
    }

    const imageUrl = image.url || `data:image/png;base64,${image.b64_json}`;
    const savedImage = await saveGeneratedImage(image, prompt, {
      prompt,
      revisedPrompt: image.revised_prompt || null,
      model: imageModel,
      size: normalizedSize,
      sourceImageFileName: sourceImageFileName || null,
      favorite: false
    });
    await recordSpend(calculateImageCostUsd(result?.usage));

    return res.json({
      imageUrl,
      revisedPrompt: image.revised_prompt || null,
      model: imageModel,
      size: normalizedSize,
      savedPath: savedImage.savedPath,
      fileName: savedImage.fileName,
      sourceImageFileName: sourceImageFileName || null
    });
  } catch (error) {
    console.error("Image API error:", error);
    return res.status(500).json({
      error: error?.message || "Image generation failed"
    });
  }
});

app.get("/api/spend", async (req, res) => {
  try {
    return res.json(await getSpendSummary());
  } catch (error) {
    console.error("Spend API error:", error);
    return res.status(500).json({ error: "Failed to load spend summary" });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    const availableModels = await getAvailableModels();

    return res.json({
      chatModels: availableModels.chatModels,
      imageModels: availableModels.imageModels,
      defaultChatModel: process.env.OPENAI_CHAT_MODEL || "gpt-5",
      defaultImageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"
    });
  } catch (error) {
    console.error("Models API error:", error);
    return res.status(500).json({ error: "Failed to load available models" });
  }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const entries = await fs.promises.readdir(conversationsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    const conversations = await Promise.all(
      files.map(async (entry) => {
        const filePath = path.join(conversationsDir, entry.name);
        const raw = await fs.promises.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);

        return {
          id: parsed.id,
          title: parsed.title || "New Conversation",
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0
        };
      })
    );

    conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json({ conversations });
  } catch (error) {
    console.error("List conversations API error:", error);
    return res.status(500).json({ error: "Failed to list conversations" });
  }
});

app.post("/api/conversations", async (req, res) => {
  try {
    const id = crypto.randomUUID().replace(/-/g, "");
    const now = new Date().toISOString();
    const messages = normalizeMessages(req.body?.messages || []);
    const title = String(req.body?.title || "").trim() || inferConversationTitle(messages);

    const conversation = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages
    };

    await fs.promises.writeFile(getConversationFilePath(id), JSON.stringify(conversation, null, 2));
    return res.status(201).json(conversation);
  } catch (error) {
    console.error("Create conversation API error:", error);
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidConversationId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const filePath = getConversationFilePath(id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const raw = await fs.promises.readFile(filePath, "utf8");
    return res.json(JSON.parse(raw));
  } catch (error) {
    console.error("Get conversation API error:", error);
    return res.status(500).json({ error: "Failed to load conversation" });
  }
});

app.put("/api/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidConversationId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const filePath = getConversationFilePath(id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const raw = await fs.promises.readFile(filePath, "utf8");
    const existing = JSON.parse(raw);

    const messages = normalizeMessages(req.body?.messages || []);
    const title = String(req.body?.title || "").trim() || inferConversationTitle(messages);

    const updated = {
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      title,
      messages
    };

    await fs.promises.writeFile(filePath, JSON.stringify(updated, null, 2));
    return res.json(updated);
  } catch (error) {
    console.error("Update conversation API error:", error);
    return res.status(500).json({ error: "Failed to save conversation" });
  }
});

app.patch("/api/images/:fileName/favorite", async (req, res) => {
  try {
    const fileName = String(req.params.fileName || "");
    if (!isSafeImageFileName(fileName)) {
      return res.status(400).json({ error: "Invalid image file name" });
    }

    const filePath = path.join(imagesDir, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Image not found" });
    }

    const favorite = Boolean(req.body?.favorite);
    const meta = await readImageMeta();

    if (!meta[fileName]) {
      meta[fileName] = {};
    }

    meta[fileName].favorite = favorite;
    await writeImageMeta(meta);

    return res.json({ fileName, favorite });
  } catch (error) {
    console.error("Favorite image API error:", error);
    return res.status(500).json({ error: "Failed to update favorite" });
  }
});

app.delete("/api/images/:fileName", async (req, res) => {
  try {
    const fileName = String(req.params.fileName || "");
    if (!isSafeImageFileName(fileName)) {
      return res.status(400).json({ error: "Invalid image file name" });
    }

    const filePath = path.join(imagesDir, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Image not found" });
    }

    await fs.promises.unlink(filePath);

    const meta = await readImageMeta();
    if (meta[fileName]) {
      delete meta[fileName];
      await writeImageMeta(meta);
    }

    return res.json({ deleted: true, fileName });
  } catch (error) {
    console.error("Delete image API error:", error);
    return res.status(500).json({ error: "Failed to delete image" });
  }
});

app.get("/api/images", async (req, res) => {
  try {
    const entries = await fs.promises.readdir(imagesDir, { withFileTypes: true });

    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name));

    const meta = await readImageMeta();

    const images = await Promise.all(
      files.map(async (fileName) => {
        const filePath = path.join(imagesDir, fileName);
        const stats = await fs.promises.stat(filePath);
        return {
          fileName,
          url: `/images/${encodeURIComponent(fileName)}`,
          createdAt: stats.mtime.toISOString(),
          bytes: stats.size,
          favorite: Boolean(meta?.[fileName]?.favorite),
          prompt: typeof meta?.[fileName]?.prompt === "string" ? meta[fileName].prompt : null,
          revisedPrompt: typeof meta?.[fileName]?.revisedPrompt === "string" ? meta[fileName].revisedPrompt : null,
          model: typeof meta?.[fileName]?.model === "string" ? meta[fileName].model : null,
          size: typeof meta?.[fileName]?.size === "string" ? meta[fileName].size : null,
          sourceImageFileName:
            typeof meta?.[fileName]?.sourceImageFileName === "string" ? meta[fileName].sourceImageFileName : null
        };
      })
    );

    images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({ images });
  } catch (error) {
    console.error("List images API error:", error);
    return res.status(500).json({ error: "Failed to list images" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
