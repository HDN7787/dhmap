export async function onRequest(context) {
  const { env, request } = context;
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });

  try {
    const sql = `
      SELECT s.id, s.url, s.title, s.description, s.status, s.registrable_domain, s.category_id, c.name AS category_name
      FROM sites s
      JOIN categories c ON c.id = s.category_id
      ORDER BY s.id DESC
      LIMIT 1000
    `;
    const { results } = await env.DB.prepare(sql).all();
    return Response.json(results);
  } catch (err) { 
    return Response.json({ error: err.message }, { status: 500 }); 
  }
}