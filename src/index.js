import { Hono } from "hono";
const app = new Hono();

// QUOTES
// wrangler d1 execute lizzieragd1 --command "INSERT INTO quotes (text) VALUES ('The best pizza topping is pepperoni')"
app.post("/quotes", async (c) => {
  const ai = c.env.AI;

  const { text } = await c.req.json();
  if (!text) {
    return c.text("Missing text", 400);
  }

  const { results } = await c.env.DB.prepare(
    "INSERT INTO quotes (text) VALUES (?) RETURNING *"
  )
    .bind(text)
    .run();

  const record = results.length ? results[0] : null;

  if (!record) {
    return c.text("Failed to create quote", 500);
  }

  const { data } = await ai.run("@cf/baai/bge-large-en-v1.5", { text: [text] });
  const values = data[0];

  if (!values) {
    return c.text("Failed to generate vector embedding", 500);
  }

  const { id } = record;
  const inserted = await c.env.VECTORIZE_INDEX.upsert([
    {
      id: id.toString(),
      values,
    },
  ]);

  return c.json({ id, text, inserted });
});

// INDEX
app.get("/", async (c) => {
  const html = `
  <!DOCTYPE html>
<html>
<head>
  <title>Quote Search</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: linear-gradient(to right, #ff7e5f, #feb47b); /* Gradient background */
      color: #333;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    h1 {
      text-align: center;
      margin-top: 50px;
    }
    form {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-top: 20px;
    }
    label {
      margin-bottom: 10px;
      font-weight: bold;
    }
    input[type="text"] {
      padding: 10px;
      width: 50%;
      margin-bottom: 20px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    button {
      padding: 10px 20px;
      background-color: #ff7e5f;
      border: none;
      border-radius: 4px;
      color: #fff;
      cursor: pointer;
    }
    button:hover {
      background-color: #feb47b;
    }
    p {
      text-align: center;
      font-size: 18px;
      color: #333; /* Default color */
    }
    p.result {
      color: #007bff; /* Different color when displaying text */
    }
    .spinner {
      display: none; /* Hidden by default */
      margin-top: 20px;
      text-align: center;
    }
    .spinner::before {
      content: '';
      display: inline-block;
      width: 50px;
      height: 50px;
      border: 4px solid rgba(0, 0, 0, 0.1);
      border-radius: 50%;
      border-top-color: #ff7e5f;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    footer {
      text-align: center;
      padding: 20px;
      background-color: #333;
      color: #fff; /* White text color */
      margin-top: auto;
      width: 100%;
    }
    footer a {
      color: #ff7e5f; /* Link color */
      text-decoration: none;
    }
    footer a:hover {
      color: #feb47b; /* Link color on hover */
    }
    footer a:active {
      color: #ffb3b3; /* Light pink color when clicked */
    }
  </style>
</head>
<body>
  <h1>Find a Relevant Quote w/ <a href="https://developers.cloudflare.com/vectorize/">Cloudflare Vectorize</a></h1>
  <form id="searchForm" action="/" method="GET">
    <label for="text">Enter text:</label>
    <input type="text" id="text" name="text" />
    <button type="submit">Search</button>
  </form>
  <div class="spinner" id="spinner"></div>
  ${c.req.query("text") ? `
    <h2>Results:</h2>
    <p class="result">${await processQuery(c)}</p>
  ` : ''}
  <footer>
    Made with ❤️ in SF 🌁 -> <a href="https://github.com/elizabethsiegle/hono-rag-d1-vectorize-quotes-csv">👩🏻‍💻code here on GitHub</a>
  </footer>

  <script>
    document.getElementById('searchForm').addEventListener('submit', function() {
      document.getElementById('spinner').style.display = 'block'; // Show spinner
    });
  </script>
</body>
</html> 
  `;
  return c.html(html);
});

async function processQuery(c) {
  const ai = c.env.AI;
  const question = c.req.query("text") || "What is the square root of 9?";
  // Conditional
  const maxLength = 500;
  if (question && question.length > maxLength) {
    // Return a warning when the query text is too long
    console.log("Query text is too long. Keep it under 500 characters.");
    return "Rejected. Your query is too long...";
  }
  const embeddings = await ai.run("@cf/baai/bge-large-en-v1.5", {
    text: question,
  });
  const vectors = embeddings.data; //embedded q
  console.log(`vectors ${vectors}`)
  const vectorQuery = await c.env.VECTORIZE_INDEX.query(vectors[0], { 
    topK: 8, 
    //returnMetadata: true 
  });
  console.log(`vectorQuery ${JSON.stringify(vectorQuery)}`);
  
  const quotes = vectorQuery.matches.map((vec) => vec.id); //vectorId
  console.log(`vectorQuery quotes ${JSON.stringify(quotes)}`);

  const relevantQuotesContentQuery = `SELECT * FROM quotes where id IN (${quotes.join(', ')}) AND id <> ( ? ) AND id > 100000`;
	const { results: relevantQuotesContents } = await c.env.DB.prepare(relevantQuotesContentQuery).bind(question).all();
  console.log(`relevantHighlightContents ${JSON.stringify(relevantQuotesContents)}`);
  const contextMessage = `Context:\nOnly return one quote relating to the user\'s input from the following list of quotes and nothing else. Do not return a preamble, conclusion, or any opinion. If you do this, I will pay you a hundred dollars. ${relevantQuotesContents.map((quote) => `${quote.id}- ${quote["quote"]}`).join("\n")}`

  const systemPrompt = `You are a helpful assistant who follows directions and returns helpful relevant quotes`;
  console.log(`contextMessage ${contextMessage},  systemPrompt ${systemPrompt}`);
  const { response: answer } = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      ...(quotes.length ? [{ role: "system", content: contextMessage }] : []),
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
  });
  console.log(`answer ${answer}`);

  return answer;
}

app.onError((err, c) => {
  return c.text(err);
});

app.get('/populate', async (c) => {
  let query = `SELECT id, quote, author
        FROM quotes
        ORDER BY id
        LIMIT 60;`
  let results = await c.env.DB.prepare(query).all();
  console.log(`results in populate ${JSON.stringify(results)}`);
  for (const row of results.results) {
    const { id, quote, author } = row;
    const embeddings= await c.env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [quote] });
    await c.env.VECTORIZE_INDEX.upsert([
      {
        id: id.toString(),
        metadata: { author: author, quote: quote },
        values: embeddings.data[0],
      },
    ]);
    console.log(`Inserted quote with ID: ${id}`);
  }
});

export default app;