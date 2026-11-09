export async function onRequest(context) {
  const { env, request } = context;
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });
  
  try {
    const sql = `
      SELECT s.id, s.url, s.title, s.created_at, s.status, s.category_id,
             u.email AS user_email, 
             c.name AS category_name
      FROM submissions s
      JOIN users u ON s.user_id = u.id
      JOIN categories c ON s.category_id = c.id
      ORDER BY s.id DESC
    `;
    const { results } = await env.DB.prepare(sql).all();
    return Response.json(results);
  } catch (err) { 
    return Response.json({ error: err.message }, { status: 500 }); 
  }
}