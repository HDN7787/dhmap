export default {
  async scheduled(event, env, ctx) {
    console.log('[cron] ⏰ 定时任务触发，时间:', new Date().toISOString());
    ctx.waitUntil(runAutomatedPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 采集、验证与SEO抓取已执行完毕，请查看后台。', { status: 200 });
    }
    return new Response('导航map 自动引擎运行中。访问 /trigger 手动触发。', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('[cron] 缺少 D1 绑定');

  // --- 第一步：抓取全新网址 ---
  let allCandidateItems = [];
  try { allCandidateItems.push(...await collectRSS()); } catch (e) { }
  try { allCandidateItems.push(...await collectGitHubRepos()); } catch (e) { }
  try { allCandidateItems.push(...await collectWebScraping()); } catch (e) { }

  const uniqueCandidates = [];
  const seenDomains = new Set();
  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    let hostname = '';
    try {
      const u = new URL(item.url);
      hostname = u.hostname.replace(/^www\./, '');
      if (hostname.includes('127.0.0.1') || hostname === 'localhost' || !hostname.includes('.')) continue;
    } catch (e) { continue; }
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue;
    uniqueCandidates.push({ url: item.url, hostname, title: item.title || hostname, description: item.description || '自动采集收录', categoryId: item.categoryId || 7 });
  }

  const itemsToVerify = uniqueCandidates.slice(0, 30);
  let insertedCount = 0;
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const isAlive = await verifyUrl(item.url);
      if (isAlive) {
        try {
          await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          // 记录采集流水
          await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          insertedCount++;
        } catch (e) { }
      }
    }));
  }
  console.log(`[cron] ✅ 新增活站: ${insertedCount} 个`);

  // --- 第二步：自动更新已有站点的 SEO 信息 ---
  console.log('[cron] 开始抓取并更正已有站点的标题与描述...');
  // 抽出 15 个需要更新信息的站点（比如刚被用户提交或采集进来，描述还是默认值的）
  const { results: sitesToUpdate } = await DB.prepare(`
    SELECT id, url, title FROM sites 
    WHERE description = '自动采集收录' OR description = '暂无描述' OR description = '' OR title LIKE '%未命名%' OR title = registrable_domain
    LIMIT 15
  `).all();

  for (const site of sitesToUpdate) {
    try {
      const seoInfo = await fetchSeoInfo(site.url);
      if (seoInfo.title || seoInfo.description) {
        await DB.prepare(`
          UPDATE sites SET 
            title = COALESCE(?, title), 
            description = COALESCE(?, description), 
            updated_at = datetime('now') 
          WHERE id = ?
        `).bind(seoInfo.title, seoInfo.description, site.id).run();
        console.log(`[cron] 📝 已更新SEO信息: ${site.url} -> ${seoInfo.title}`);
      }
    } catch (e) { }
  }
}

// ================= 抓取网页 SEO 信息 =================
async function fetchSeoInfo(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    // 只解析 html
    if (!res.headers.get('content-type')?.includes('text/html')) return {};
    const html = await res.text();
    
    // 正则提取 <title>
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().replace(/\s+/g, ' ').substring(0, 50);

    // 正则提取 <meta name="description">
    let description = '';
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || 
                      html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
    if (descMatch) description = descMatch[1].trim().replace(/\s+/g, ' ').substring(0, 150);

    clearTimeout(timeoutId);
    return { title, description };
  } catch (err) {
    clearTimeout(timeoutId);
    return {};
  }
}

// ================= 抓取工具 (RSS, GitHub, Web) =================
async function collectRSS() {
  const feeds = [{ url: 'https://sspai.com/feed', cat: 5 }, { url: 'https://www.ithome.com/rss/', cat: 6 }];
  let items = [];
  for (const feed of feeds) {
    try {
      const xml = await (await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        if (!match[1].includes('.xml') && match[1] !== feed.url) items.push({ url: match[1], title: '最新资讯', description: 'RSS资讯', categoryId: feed.cat });
      }
    } catch (e) {}
  }
  return items;
}

async function collectGitHubRepos() {
  let items = [];
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=topic:bookmark&sort=stars&order=desc&per_page=5', { headers: { 'User-Agent': 'NavMap-Bot', 'Accept': 'application/vnd.github.v3+json' } });
    if (res.ok) {
      const data = await res.json();
      for (const repo of data.items) items.push({ url: repo.html_url, title: repo.name, description: repo.description || 'GitHub开源导航项目', categoryId: 5 });
    }
  } catch (e) {}
  return items;
}

async function collectWebScraping() {
  let items = [];
  try {
    const res = await fetch('https://github.com/trending?since=daily', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      await new HTMLRewriter().on('article.Box-row h2 a', {
        element(element) {
          const href = element.getAttribute('href');
          if (href) items.push({ url: `https://github.com${href}`, title: href.replace(/^\//, ''), description: 'GitHub Trending 热门', categoryId: 5 });
        }
      }).transform(res).text();
    }
  } catch (e) {}
  return items;
}

async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } });
    clearTimeout(timeoutId);
    return [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
  } catch (err) { return false; }
}