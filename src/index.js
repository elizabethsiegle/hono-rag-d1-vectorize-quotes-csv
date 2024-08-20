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
  const ai = c.env.AI;
  const question = c.req.query("text") || "What is the square root of 9?";
  // Conditional
  const maxLength = 500;
  if (question && question.length > maxLength) {
    // Return a warning when the query text is too long
    console.log("Query text is too long. Keep it under 500 characters.");
    return c.json("Rejected. Your query is too long...", 500);
  }
  const embeddings = await ai.run("@cf/baai/bge-large-en-v1.5", {
    text: question,
  });
  const vectors = embeddings.data; //embedded q
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

  const systemPrompt = `You are a helpful assistant`;
  console.log(`contextMessage ${contextMessage},  systemPrompt ${systemPrompt}`);
  const { response: answer } = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      ...(quotes.length ? [{ role: "system", content: contextMessage }] : []),
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
  });
  console.log(`answer ${answer}`);

  // return c.text(answer);
  return c.json(answer);
});

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
