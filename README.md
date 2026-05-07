# Vibe GPT + Image Builder

A ChatGPT-style web interface that uses your OpenAI API key for:
- Conversational chat with the latest GPT model
- Image generation with the latest OpenAI image API

## 1. Install

```bash
npm install
```

## 2. Configure

Copy `.env.example` to `.env` and set your key:

```bash
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_CHAT_MODEL=gpt-5
OPENAI_IMAGE_MODEL=gpt-image-1
PORT=3000
```

Alternative: place your API key directly in `key.txt` (project root). The server will use `OPENAI_API_KEY` first, then fall back to `key.txt`.

## 3. Run

```bash
npm run dev
```

Then open: http://localhost:3000

## Notes

- Your API key stays on the server (`server.js`) and is never exposed to the browser.
- You can switch models using `OPENAI_CHAT_MODEL` and `OPENAI_IMAGE_MODEL`.
