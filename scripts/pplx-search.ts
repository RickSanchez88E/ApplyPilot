/**
 * PPLX Search CLI — calls Perplexity Sonar API for online search
 * Usage: bun run scripts/pplx-search.ts "your question here"
 */

const PPLX_API_KEY = process.env.PPLX_API_KEY;

if (!PPLX_API_KEY) {
  console.error("❌ PPLX_API_KEY not set in environment");
  process.exit(1);
}

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: bun run scripts/pplx-search.ts \"your question\"");
  process.exit(1);
}

console.log(`🔍 Searching PPLX: "${query}"\n`);

const response = await fetch("https://api.perplexity.ai/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${PPLX_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "sonar",
    messages: [
      {
        role: "system",
        content: "You are a research assistant. Provide detailed, factual answers with specific numbers, statistics, and data points. Always cite sources. Answer in the user's language."
      },
      {
        role: "user",
        content: query
      }
    ],
    temperature: 0.2,
    max_tokens: 4096,
    return_citations: true,
    search_recency_filter: "month",
  }),
});

if (!response.ok) {
  const err = await response.text();
  console.error(`❌ PPLX API error ${response.status}: ${err}`);
  process.exit(1);
}

const data = await response.json() as any;
const content = data.choices?.[0]?.message?.content ?? "No response";
const citations = data.citations ?? [];

console.log("━".repeat(60));
console.log(content);
console.log("━".repeat(60));

if (citations.length > 0) {
  console.log("\n📎 Citations:");
  citations.forEach((c: string, i: number) => {
    console.log(`  [${i + 1}] ${c}`);
  });
}
