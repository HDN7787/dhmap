export async function onRequest(context) {
  const { env, params } = context;
  try {
    const site = await env.DB.prepare(`
      SELECT s.*, c.name as category_name 
      FROM sites s JOIN categories c ON c.id = s.category_id 
      WHERE s.id = ?
    `).bind(params.id).first();
    if (!site) return Response.json({ error: 'Not Found' }, { status: 404 });
    return Response.json(site);
  } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
}