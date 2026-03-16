import express from "express";
import crypto  from "crypto";
import axios   from "axios";

const app  = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────
function requireApiKey(req, res, next) {
    const provided = req.headers["x-api-key"];
    const valid    = process.env.WEBMCP_API_KEY;

    // Constant-time compare to prevent timing attacks
    const match = provided && crypto.timingSafeEqual(
        Buffer.from(provided.padEnd(64)),
        Buffer.from(valid.padEnd(64))
    );

    if (!match) {
        console.warn(`[AUTH FAIL] ${new Date().toISOString()} — bad key from ${req.ip}`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// ── In-memory scratchpad (use Redis in production) ────────────
const notes = {};

// ── Tool definitions ──────────────────────────────────────────
const TOOLS = [
    {
        name: "search_web",
        description: `Search the web for current information.
      Use for recent events, live data, or anything after your training cutoff.
      Do NOT use for general knowledge you already know.
      Returns top results with title, URL, and summary.`,
        inputSchema: {
            type: "object",
            properties: {
                query:       { type: "string",  description: "Specific search query" },
                max_results: { type: "number",  description: "Results to return (1-10). Default 5." }
            },
            required: ["query"]
        }
    },
    {
        name: "fetch_page_content",
        description: `Fetches the full text content of a webpage.
      Use AFTER search_web when you need to read a full article, not just its snippet.
      Returns the main text of the page, stripped of HTML.`,
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Full URL including https://" }
            },
            required: ["url"]
        }
    },
    {
        name: "save_note",
        description: `Save a piece of information to your scratchpad with a key.
      Use mid-task to remember important findings before moving to the next step.
      Overwrites if the key already exists.`,
        inputSchema: {
            type: "object",
            properties: {
                key:     { type: "string", description: "Short label, e.g. 'competitor_prices'" },
                content: { type: "string", description: "The information to save." }
            },
            required: ["key", "content"]
        }
    },
    {
        name: "get_note",
        description: `Retrieve a note you saved earlier by its key.
      Use when you need to recall something stored mid-task.`,
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "The key used when saving." }
            },
            required: ["key"]
        }
    }
];

// ── Tool handlers ─────────────────────────────────────────────
async function search_web({ query, max_results = 5 }) {
    // Using DuckDuckGo's free instant answer API
    const res = await axios.get("https://api.duckduckgo.com/", {
        params: { q: query, format: "json", no_redirect: 1 }
    });
    const results = res.data.RelatedTopics?.slice(0, max_results) || [];

    if (results.length === 0) {
        return `No results found for "${query}". Try rephrasing the query.`;
    }

    return results.map((r, i) =>
        `${i + 1}. ${r.Text || "No description"}\n   URL: ${r.FirstURL || "N/A"}`
    ).join("\n\n");
}

async function fetch_page_content({ url }) {
    try {
        const res  = await axios.get(url, { timeout: 8000 });
        // Strip HTML tags, collapse whitespace
        const text = res.data
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 4000); // cap at 4000 chars to protect context window
        return text || "Page appears to be empty or unreadable.";
    } catch (e) {
        return `Could not fetch page: ${e.message}. Try a different URL.`;
    }
}

function save_note({ key, content }) {
    notes[key] = content;
    return `Saved note under key "${key}".`;
}

function get_note({ key }) {
    return notes[key] ?? `No note found for key "${key}". Check the key name.`;
}

const handlers = { search_web, fetch_page_content, save_note, get_note };

// ── Routes ────────────────────────────────────────────────────

// Tool discovery — Claude calls this on connect
app.get("/", requireApiKey, (req, res) => {
    res.json({ tools: TOOLS });
});

// Tool execution — Claude calls this to run a tool
app.post("/", requireApiKey, async (req, res) => {
    const { method, params } = req.body;

    if (method !== "tools/call") {
        return res.status(400).json({ error: `Unknown method: ${method}` });
    }

    const fn = handlers[params?.name];
    if (!fn) {
        return res.status(404).json({ error: `Unknown tool: ${params?.name}` });
    }

    try {
        console.log(`[TOOL] ${params.name}`, JSON.stringify(params.arguments));
        const result = await fn(params.arguments);
        res.json({ content: [{ type: "text", text: result }] });
    } catch (e) {
        // Return error as text — agent can reason about it
        res.json({ content: [{ type: "text", text: `Tool error: ${e.message}` }] });
    }
});

app.listen(3000, () => console.log("WebMCP server running on :3000"));