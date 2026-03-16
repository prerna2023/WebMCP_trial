import express from "express";
import crypto  from "crypto";

const app  = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────
function requireApiKey(req, res, next) {
    const provided = req.headers["x-api-key"];
    const valid    = process.env.WEBMCP_API_KEY;

    const match = provided && crypto.timingSafeEqual(
        Buffer.from(provided.padEnd(64)),
        Buffer.from(valid.padEnd(64))
    );

    if (!match) {
        console.warn(`[AUTH FAIL] ${new Date().toISOString()}`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// ── In-memory scratchpad ──────────────────────────────────────
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
                query:       { type: "string", description: "Specific search query" },
                max_results: { type: "number", description: "Results to return (1-10). Default 5." }
            },
            required: ["query"]
        }
    },
    {
        name: "fetch_page_content",
        description: `Fetches the full text content of a webpage.
      Use AFTER search_web when you need the full article, not just the snippet.
      Returns the main text stripped of HTML.`,
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
      Use mid-task to remember important findings.
      Overwrites if the key already exists.`,
        inputSchema: {
            type: "object",
            properties: {
                key:     { type: "string", description: "Short label e.g. 'competitor_prices'" },
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

// ── Tool handlers (using built-in fetch, no axios needed) ─────
async function search_web({ query, max_results = 5 }) {
    try {
        // DuckDuckGo HTML search — more reliable than the JSON API
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res  = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; research-agent/1.0)"
            },
            signal: AbortSignal.timeout(8000)
        });

        const html = await res.text();

        // Extract result snippets from HTML
        const results = [];
        const pattern = /<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;
        const titles  = /<a class="result__a"[^>]*>(.*?)<\/a>/gs;

        const titleMatches   = [...html.matchAll(titles)].slice(0, max_results);
        const snippetMatches = [...html.matchAll(pattern)].slice(0, max_results);

        for (let i = 0; i < Math.min(titleMatches.length, max_results); i++) {
            const title   = titleMatches[i][1].replace(/<[^>]+>/g, "").trim();
            const snippet = snippetMatches[i]?.[1].replace(/<[^>]+>/g, "").trim() ?? "";
            results.push(`${i + 1}. ${title}\n   ${snippet}`);
        }

        if (results.length === 0) {
            return `No results found for "${query}". Try a different search term.`;
        }

        return `Search results for "${query}":\n\n${results.join("\n\n")}`;

    } catch (e) {
        return `Search failed: ${e.message}. Try rephrasing the query.`;
    }
}

async function fetch_page_content({ url }) {
    try {
        const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const html = await res.text();

        const text = html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 4000);

        return text || "Page appears empty or unreadable.";
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
app.get("/", requireApiKey, (req, res) => {
    res.json({ tools: TOOLS });
});

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
        res.json({ content: [{ type: "text", text: `Tool error: ${e.message}` }] });
    }
});

app.listen(3000, () => console.log("WebMCP server running on :3000"));