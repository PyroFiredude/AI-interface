const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const sendBtn = document.getElementById("send-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const conversationList = document.getElementById("conversation-list");
const imageViewerBtn = document.getElementById("image-viewer-btn");
const imageViewerBtnPanel = document.getElementById("image-viewer-btn-panel");

const imageViewerModal = document.getElementById("image-viewer-modal");
const imageViewerClose = document.getElementById("image-viewer-close");
const imageViewerGrid = document.getElementById("image-viewer-grid");
const favoritesOnlyToggle = document.getElementById("favorites-only-toggle");
const bulkFavoriteBtn = document.getElementById("bulk-favorite-btn");
const bulkDeleteBtn = document.getElementById("bulk-delete-btn");

const imageForm = document.getElementById("image-form");
const imagePrompt = document.getElementById("image-prompt");
const imageSize = document.getElementById("image-size");
const customSizeControls = document.getElementById("custom-size-controls");
const imageWidth = document.getElementById("image-width");
const imageHeight = document.getElementById("image-height");
const imageResult = document.getElementById("image-result");
const generateBtn = document.getElementById("generate-btn");
const imageEditState = document.getElementById("image-edit-state");
const imageEditLabel = document.getElementById("image-edit-label");
const clearImageEditBtn = document.getElementById("clear-image-edit-btn");

const chatModelSelect = document.getElementById("chat-model-select");
const imageModelSelect = document.getElementById("image-model-select");
const spendSessionValue = document.getElementById("spend-session-value");
const spendMonthValue = document.getElementById("spend-month-value");
const spendMeta = document.getElementById("spend-meta");

let messages = [
  {
    role: "assistant",
    content: "Tell me what you want to build or visualize."
  }
];
let currentConversationId = null;
let conversationSummaries = [];
let favoritesOnly = false;
let imageViewerImages = [];
let pendingImageEdit = null;
const selectedImageFiles = new Set();

setSelectOptions(chatModelSelect, ["gpt-5"], "gpt-5");
setSelectOptions(imageModelSelect, ["gpt-image-1"], "gpt-image-1");

initializeApp();

imageSize.addEventListener("change", () => {
  const isCustom = imageSize.value === "custom";
  customSizeControls.classList.toggle("hidden", !isCustom);
});

clearImageEditBtn.addEventListener("click", () => {
  clearPendingImageEdit();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

newChatBtn.addEventListener("click", () => {
  createNewConversation();
});

if (imageViewerBtn) {
  imageViewerBtn.addEventListener("click", openImageViewer);
}

if (imageViewerBtnPanel) {
  imageViewerBtnPanel.addEventListener("click", openImageViewer);
}

imageViewerClose.addEventListener("click", () => {
  closeImageViewer();
});

favoritesOnlyToggle.addEventListener("change", async () => {
  favoritesOnly = favoritesOnlyToggle.checked;
  renderImageGallery();
});

bulkFavoriteBtn.addEventListener("click", async () => {
  const files = [...selectedImageFiles];
  if (!files.length) {
    return;
  }

  await Promise.all(files.map((fileName) => toggleFavoriteImage(fileName, true, false)));
  await loadImageGallery();
});

bulkDeleteBtn.addEventListener("click", async () => {
  const files = [...selectedImageFiles];
  if (!files.length) {
    return;
  }

  const confirmed = confirm(`Delete ${files.length} selected image(s)?`);
  if (!confirmed) {
    return;
  }

  await Promise.all(files.map((fileName) => deleteImage(fileName, false)));
  await loadImageGallery();
});

imageViewerModal.addEventListener("click", (event) => {
  if (event.target === imageViewerModal) {
    closeImageViewer();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageViewerModal.classList.contains("hidden")) {
    closeImageViewer();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const content = chatInput.value.trim();
  if (!content) return;

  messages.push({ role: "user", content });
  chatInput.value = "";

  const imageRequestPrompt = extractImagePromptFromChat(content);
  if (imageRequestPrompt) {
    await handleChatImageRequest(imageRequestPrompt);
    return;
  }

  const requestMessages = serializeMessages(messages);
  messages.push({ role: "assistant", content: "Thinking...", pending: true });
  const pendingAssistantIndex = messages.length - 1;
  renderChat();
  await saveCurrentConversation();

  sendBtn.disabled = true;
  chatInput.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: requestMessages,
        model: chatModelSelect.value
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.error || `Chat request failed (${response.status})`);
    }

    const assistantReply =
      typeof data?.outputText === "string" && data.outputText.trim()
        ? data.outputText.trim()
        : "I could not generate a response.";

    messages[pendingAssistantIndex].content = assistantReply;
    messages[pendingAssistantIndex].pending = false;
    renderChat();
    await saveCurrentConversation();
    await loadSpendSummary();
  } catch (error) {
    messages[pendingAssistantIndex].content = `Error: ${error.message}`;
    messages[pendingAssistantIndex].pending = false;
    renderChat();
    await saveCurrentConversation();
  } finally {
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

imageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = imagePrompt.value.trim();
  if (!prompt) return;

  try {
    const selectedSize = resolveSelectedImageSize();
    const data = await generateImageWithPrompt(prompt, selectedSize);
    appendGeneratedImageToConversation(prompt, selectedSize, data);
    await saveCurrentConversation();
  } catch (error) {
    imageResult.classList.remove("placeholder");
    imageResult.textContent = `Error: ${error.message}`;
  }
});

async function handleChatImageRequest(prompt) {
  clearPendingImageEdit();
  imagePrompt.value = prompt;
  const pendingMessage = { role: "assistant", content: "Sending this to Image Studio...", pending: true };
  messages.push(pendingMessage);
  const pendingAssistantIndex = messages.length - 1;
  renderChat();
  await saveCurrentConversation();

  sendBtn.disabled = true;
  chatInput.disabled = true;

  try {
    const selectedSize = resolveSelectedImageSize();
    const data = await generateImageWithPrompt(prompt, selectedSize);
    messages[pendingAssistantIndex].content = "Image generated in Image Studio.";
    messages[pendingAssistantIndex].pending = false;
    appendGeneratedImageToConversation(prompt, selectedSize, data);
    renderChat();
    await saveCurrentConversation();
  } catch (error) {
    messages[pendingAssistantIndex].content = `Error: ${error.message}`;
    messages[pendingAssistantIndex].pending = false;
    renderChat();
    await saveCurrentConversation();
  } finally {
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

function renderChat() {
  chatLog.innerHTML = "";

  for (const message of messages) {
    const bubble = document.createElement("div");
    const isUser = message.role === "user";
    bubble.className = `bubble ${isUser ? "user" : "assistant"}`;

    if (!isUser && message.pending) {
      bubble.classList.add("thinking");

      const spinner = document.createElement("span");
      spinner.className = "thinking-spinner";
      spinner.setAttribute("aria-hidden", "true");

      const label = document.createElement("span");
      label.textContent = "Thinking...";

      bubble.appendChild(spinner);
      bubble.appendChild(label);
      chatLog.appendChild(bubble);
      continue;
    }

    if (message.imageRef && !isUser) {
      bubble.classList.add("image-bubble");

      if (message.content) {
        const text = document.createElement("p");
        text.className = "image-bubble-text";
        text.textContent = message.content;
        bubble.appendChild(text);
      }

      const inlineImage = document.createElement("img");
      inlineImage.className = "chat-inline-image";
      inlineImage.src = `/images/${encodeURIComponent(message.imageRef)}`;
      inlineImage.alt = message.imagePrompt || "Generated image";
      inlineImage.loading = "lazy";
      inlineImage.addEventListener("error", () => {
        inlineImage.remove();
        const deleted = document.createElement("p");
        deleted.className = "deleted-image-text";
        deleted.textContent = "image deleted";
        bubble.appendChild(deleted);
      }, { once: true });
      bubble.appendChild(inlineImage);
    } else {
      bubble.textContent = message.content;
    }

    chatLog.appendChild(bubble);
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

function closeImageViewer() {
  imageViewerModal.classList.add("hidden");
  imageViewerModal.setAttribute("aria-hidden", "true");
}

async function openImageViewer() {
  imageViewerModal.classList.remove("hidden");
  imageViewerModal.setAttribute("aria-hidden", "false");
  await loadImageGallery();
}

async function loadImageGallery() {
  imageViewerGrid.innerHTML = '<p class="viewer-empty">Loading images...</p>';

  try {
    const response = await fetch("/api/images");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to load images");
    }

    imageViewerImages = Array.isArray(data?.images) ? data.images : [];

    for (const fileName of [...selectedImageFiles]) {
      if (!imageViewerImages.some((image) => image.fileName === fileName)) {
        selectedImageFiles.delete(fileName);
      }
    }

    renderImageGallery();
  } catch (error) {
    imageViewerGrid.innerHTML = `<p class="viewer-empty">Error: ${error.message}</p>`;
  }
}

function renderImageGallery() {
  const images = favoritesOnly
    ? imageViewerImages.filter((image) => image.favorite)
    : imageViewerImages;

  updateBulkActionButtons();

  if (images.length === 0) {
    imageViewerGrid.innerHTML = `<p class="viewer-empty">${favoritesOnly ? "No favorite images yet." : "No images saved yet."}</p>`;
    return;
  }

  imageViewerGrid.innerHTML = "";

  for (const image of images) {
      const card = document.createElement("article");
      card.className = "viewer-item";

      if (image.favorite) {
        card.classList.add("favorite");
      }

      const img = document.createElement("img");
      img.src = image.url;
      img.alt = image.fileName || "Saved image";
      img.loading = "lazy";

      const selector = document.createElement("label");
      selector.className = "viewer-selector";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedImageFiles.has(image.fileName);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedImageFiles.add(image.fileName);
        } else {
          selectedImageFiles.delete(image.fileName);
        }
        updateBulkActionButtons();
      });

      const checkboxLabel = document.createElement("span");
      checkboxLabel.textContent = "Select";
      selector.appendChild(checkbox);
      selector.appendChild(checkboxLabel);

      const meta = document.createElement("p");
      const when = image.createdAt ? new Date(image.createdAt).toLocaleString() : "Unknown date";
      meta.textContent = `${image.fileName || "image"} (${when})`;

      const actions = document.createElement("div");
      actions.className = "viewer-actions";

      const favoriteBtn = document.createElement("button");
      favoriteBtn.type = "button";
      favoriteBtn.className = "ghost-btn viewer-btn";
      favoriteBtn.textContent = image.favorite ? "Unfavorite" : "Favorite";
      favoriteBtn.addEventListener("click", async () => {
        await toggleFavoriteImage(image.fileName, !Boolean(image.favorite), true);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-btn viewer-btn danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        const confirmed = confirm(`Delete image ${image.fileName}?`);
        if (!confirmed) {
          return;
        }
        await deleteImage(image.fileName, true);
      });

      const reusePromptBtn = document.createElement("button");
      reusePromptBtn.type = "button";
      reusePromptBtn.className = "ghost-btn viewer-btn";
      reusePromptBtn.textContent = "Reuse Prompt";
      reusePromptBtn.disabled = !getImagePromptForReuse(image);
      reusePromptBtn.addEventListener("click", () => {
        reuseImagePrompt(image);
      });

      const editImageBtn = document.createElement("button");
      editImageBtn.type = "button";
      editImageBtn.className = "ghost-btn viewer-btn";
      editImageBtn.textContent = "Edit This Image";
      editImageBtn.addEventListener("click", () => {
        startImageEdit(image);
      });

      actions.appendChild(reusePromptBtn);
      actions.appendChild(editImageBtn);
      actions.appendChild(favoriteBtn);
      actions.appendChild(deleteBtn);

      card.appendChild(selector);
      card.appendChild(img);
      card.appendChild(meta);
      card.appendChild(actions);
      imageViewerGrid.appendChild(card);
  }
}

async function toggleFavoriteImage(fileName, favorite, shouldReload = true) {
  const response = await fetch(`/api/images/${encodeURIComponent(fileName)}/favorite`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite })
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || "Failed to update favorite");
  }

  if (shouldReload) {
    await loadImageGallery();
  }
}

async function deleteImage(fileName, shouldReload = true) {
  const response = await fetch(`/api/images/${encodeURIComponent(fileName)}`, {
    method: "DELETE"
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || "Failed to delete image");
  }

  selectedImageFiles.delete(fileName);

  if (shouldReload) {
    await loadImageGallery();
  }
}

function updateBulkActionButtons() {
  const hasSelection = selectedImageFiles.size > 0;
  bulkFavoriteBtn.disabled = !hasSelection;
  bulkDeleteBtn.disabled = !hasSelection;
}

async function initializeApp() {
  renderChat();
  await loadAvailableModels();
  await loadSpendSummary();
  await refreshConversations();

  if (conversationSummaries.length > 0) {
    await loadConversation(conversationSummaries[0].id);
  } else {
    await createNewConversation();
  }
}

async function createNewConversation() {
  messages = [
    {
      role: "assistant",
      content: "New conversation started. What are we creating today?"
    }
  ];
  renderChat();

  try {
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: serializeMessages(messages) })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to create conversation");
    }

    currentConversationId = data.id;
    await refreshConversations();
  } catch (error) {
    console.error(error);
  }
}

async function saveCurrentConversation() {
  if (!currentConversationId) {
    return;
  }

  try {
    await fetch(`/api/conversations/${currentConversationId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: inferConversationTitle(),
        messages: serializeMessages(messages)
      })
    });
    await refreshConversations();
  } catch (error) {
    console.error(error);
  }
}

async function refreshConversations() {
  try {
    const response = await fetch("/api/conversations");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to fetch conversations");
    }

    conversationSummaries = Array.isArray(data?.conversations) ? data.conversations : [];
    renderConversationList();
  } catch (error) {
    conversationList.innerHTML = `<p class="conversation-empty">Error: ${error.message}</p>`;
  }
}

function renderConversationList() {
  if (!conversationSummaries.length) {
    conversationList.innerHTML = '<p class="conversation-empty">No saved conversations yet.</p>';
    return;
  }

  conversationList.innerHTML = "";

  for (const conversation of conversationSummaries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "conversation-item";
    if (conversation.id === currentConversationId) {
      item.classList.add("active");
    }

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || "New Conversation";

    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    meta.textContent = conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleString() : "";

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener("click", async () => {
      await loadConversation(conversation.id);
    });

    conversationList.appendChild(item);
  }
}

async function loadConversation(id) {
  try {
    const response = await fetch(`/api/conversations/${id}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to load conversation");
    }

    currentConversationId = data.id;
    messages = Array.isArray(data.messages) && data.messages.length
      ? data.messages.map((message) => ({
          role: message.role,
          content: message.content,
          imageRef: message.imageRef,
          imagePrompt: message.imagePrompt,
          imageSize: message.imageSize
        }))
      : [{ role: "assistant", content: "New conversation started. What are we creating today?" }];

    renderChat();
    renderConversationList();
  } catch (error) {
    console.error(error);
  }
}

function serializeMessages(source) {
  return source
    .filter((message) => !message.pending)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || ""),
      imageRef: message.imageRef || undefined,
      imagePrompt: message.imagePrompt || undefined,
      imageSize: message.imageSize || undefined
    }));
}

function inferConversationTitle() {
  const firstUser = messages.find((message) => message.role === "user");
  return firstUser?.content?.slice(0, 70) || "New Conversation";
}

function resolveSelectedImageSize() {
  let selectedSize = imageSize.value;

  if (selectedSize === "custom") {
    const width = Number.parseInt(imageWidth.value, 10);
    const height = Number.parseInt(imageHeight.value, 10);

    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256) {
      throw new Error("Enter valid custom width and height (minimum 256).");
    }

    selectedSize = `${width}x${height}`;
  }

  return selectedSize;
}

function applySelectedImageSize(size) {
  const presetSizes = ["1024x1024", "1536x1024", "1024x1536"];

  if (!size) {
    return;
  }

  if (presetSizes.includes(size)) {
    imageSize.value = size;
    customSizeControls.classList.add("hidden");
    return;
  }

  const match = /^([0-9]+)x([0-9]+)$/i.exec(size);
  if (!match) {
    return;
  }

  imageSize.value = "custom";
  imageWidth.value = match[1];
  imageHeight.value = match[2];
  customSizeControls.classList.remove("hidden");
}

function getImagePromptForReuse(image) {
  return image?.prompt || image?.revisedPrompt || "";
}

function reuseImagePrompt(image) {
  clearPendingImageEdit();
  imagePrompt.value = getImagePromptForReuse(image);
  applySelectedImageSize(image?.size);

  if (image?.model && [...imageModelSelect.options].some((option) => option.value === image.model)) {
    imageModelSelect.value = image.model;
  }

  closeImageViewer();
  imagePrompt.focus();
}

function renderImageEditState() {
  if (!pendingImageEdit) {
    imageEditState.classList.add("hidden");
    imageEditLabel.textContent = "Editing image";
    return;
  }

  imageEditState.classList.remove("hidden");
  imageEditLabel.textContent = `Revising ${pendingImageEdit.fileName}`;
}

function clearPendingImageEdit() {
  pendingImageEdit = null;
  renderImageEditState();
}

function startImageEdit(image) {
  const reusablePrompt = getImagePromptForReuse(image);

  pendingImageEdit = {
    fileName: image.fileName
  };

  imagePrompt.value = reusablePrompt || "Describe how to revise this image...";
  applySelectedImageSize(image?.size || "1024x1024");

  renderImageEditState();
  closeImageViewer();
  imagePrompt.focus();
}

async function generateImageWithPrompt(prompt, selectedSize) {
  generateBtn.disabled = true;
  imageResult.classList.remove("placeholder");
  imageResult.innerHTML = "";

  const progressWrap = document.createElement("div");
  progressWrap.className = "progress-wrap";

  const progressLabel = document.createElement("p");
  progressLabel.className = "progress-label";
  progressLabel.textContent = "Generating image... 0%";

  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";

  const progressFill = document.createElement("div");
  progressFill.className = "progress-fill";
  progressBar.appendChild(progressFill);

  progressWrap.appendChild(progressLabel);
  progressWrap.appendChild(progressBar);
  imageResult.appendChild(progressWrap);

  let progress = 0;
  const progressTimer = setInterval(() => {
    const increment = progress < 40 ? 7 : progress < 70 ? 4 : progress < 90 ? 2 : 1;
    progress = Math.min(95, progress + increment);
    progressLabel.textContent = `Generating image... ${progress}%`;
    progressFill.style.width = `${progress}%`;
  }, 400);

  try {
    const response = await fetch("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        size: selectedSize,
        model: imageModelSelect.value,
        sourceImageFileName: pendingImageEdit?.fileName
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Image request failed");
    }

    clearInterval(progressTimer);
    progressLabel.textContent = "Generating image... 100%";
    progressFill.style.width = "100%";

    imageResult.innerHTML = "";

    const img = document.createElement("img");
    img.src = data.imageUrl;
    img.alt = prompt;
    imageResult.appendChild(img);

    if (data.revisedPrompt) {
      const revised = document.createElement("p");
      revised.className = "revised";
      revised.textContent = `Revised prompt: ${data.revisedPrompt}`;
      imageResult.appendChild(revised);
    }

    if (data.savedPath) {
      const saved = document.createElement("p");
      saved.className = "revised";
      saved.textContent = `Saved to: ${data.savedPath}`;
      imageResult.appendChild(saved);
    }

    if (!imageViewerModal.classList.contains("hidden")) {
      await loadImageGallery();
    }

    clearPendingImageEdit();
    await loadSpendSummary();

    return data;
  } finally {
    clearInterval(progressTimer);
    generateBtn.disabled = false;
  }
}

function appendGeneratedImageToConversation(prompt, selectedSize, imageData) {
  if (!imageData?.fileName) {
    return;
  }

  messages.push({
    role: "assistant",
    content: imageData?.sourceImageFileName ? `Revised image for: ${prompt}` : `Image generated for: ${prompt}`,
    imageRef: imageData.fileName,
    imagePrompt: prompt,
    imageSize: selectedSize
  });
  renderChat();
}

function extractImagePromptFromChat(text) {
  const directPattern = /^\s*(?:\/image|\/imagine|image:|imagine:)\s+(.+)$/i;
  const directMatch = text.match(directPattern);
  if (directMatch?.[1]) {
    return directMatch[1].trim();
  }

  const naturalPattern = /^\s*(?:create|generate|make|draw)\s+(?:an?\s+)?image(?:\s+of|\s+for)?\s+(.+)$/i;
  const naturalMatch = text.match(naturalPattern);
  if (naturalMatch?.[1]) {
    return naturalMatch[1].trim();
  }

  return null;
}

function formatGbp(amount) {
  const numericAmount = Number(amount || 0);

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: Math.abs(numericAmount) < 1 ? 4 : 2,
    maximumFractionDigits: Math.abs(numericAmount) < 1 ? 4 : 2
  }).format(numericAmount);
}

function renderSpendSummary(summary) {
  spendSessionValue.textContent = formatGbp(summary?.session?.gbp || 0);
  spendMonthValue.textContent = formatGbp(summary?.month?.gbp || 0);

  if (summary?.estimated) {
    spendMeta.textContent = `Estimated from local API usage. ${summary.currentMonth} month-to-date.`;
    return;
  }

  spendMeta.textContent = "Spend loaded.";
}

async function loadSpendSummary() {
  try {
    const response = await fetch("/api/spend");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to load spend summary");
    }

    renderSpendSummary(data);
  } catch (error) {
    spendSessionValue.textContent = "Unavailable";
    spendMonthValue.textContent = "Unavailable";
    spendMeta.textContent = error.message;
  }
}

function setSelectOptions(select, modelIds, selectedValue) {
  select.innerHTML = "";

  for (const modelId of modelIds) {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    select.appendChild(option);
  }

  if (selectedValue && modelIds.includes(selectedValue)) {
    select.value = selectedValue;
  }
}

async function loadAvailableModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to load available models");
    }

    const chatModels = Array.isArray(data?.chatModels) && data.chatModels.length
      ? data.chatModels
      : ["gpt-5"];
    const imageModels = Array.isArray(data?.imageModels) && data.imageModels.length
      ? data.imageModels
      : ["gpt-image-1"];

    setSelectOptions(chatModelSelect, chatModels, data?.defaultChatModel || "gpt-5");
    setSelectOptions(imageModelSelect, imageModels, data?.defaultImageModel || "gpt-image-1");
  } catch (error) {
    setSelectOptions(chatModelSelect, ["gpt-5"], "gpt-5");
    setSelectOptions(imageModelSelect, ["gpt-image-1"], "gpt-image-1");
    spendMeta.textContent = `Estimated from local API usage. Model list unavailable: ${error.message}`;
  }
}
