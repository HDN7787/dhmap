export default {
  async scheduled(event, env, ctx) {
    console.log('[cron] ⏰ 定时任务触发，时间:', new Date().toISOString());
    ctx.waitUntil(runAutomatedPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 全引擎采集与SEO抓取执行完毕，请查看后台。', { status: 200 });
    }
    return new Response('导航map 自动引擎运行中。访问 /trigger 手动触发。', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('[cron] 缺少 D1 绑定');

  console.log('[cron] 开始执行多引擎采集...');
  let allCandidateItems = [];

  // 引擎 1: RSS (新闻资讯)
  try { allCandidateItems.push(...await collectRSS()); } catch (e) { }
  
  // 引擎 2: GitHub API (开源项目)
  try { allCandidateItems.push(...await collectGitHubRepos()); } catch (e) { }
  
  // 引擎 3: GitHub Awesome 仓库 Markdown 链接 (垂直领域宝藏)
  try { allCandidateItems.push(...await collectAwesomeLists()); } catch (e) { }

  // 引擎 4: Public APIs 公共接口库 (开发者工具)
  try { allCandidateItems.push(...await collectPublicAPIs()); } catch (e) { }

  // 引擎 5: 网页 DOM 爬虫 (如 Trending 榜单)
  try { allCandidateItems.push(...await collectWebScraping()); } catch (e) { }

  // --- 统一去重与验证 ---
  const uniqueCandidates = [];
  const seenDomains = new Set();
  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    let hostname = '';
    try {
      const u = new URL(item.url);
      hostname = u.hostname.replace(/^www\./, '');
      // 过滤掉 github.com 防止自我循环采集
      if (hostname.includes('127.0.0.1') || hostname === 'localhost' || hostname === 'github.com' || !hostname.includes('.')) continue;
    } catch (e) { continue; }
    
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    // 数据库去重
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue;
    
    uniqueCandidates.push({ 
      url: item.url, 
      hostname, 
      title: item.title || hostname, 
      description: item.description || '自动采集收录', 
      categoryId: item.categoryId || 7 
    });
  }

  // 每次任务限制验证 40 个，防止 Cloudflare 免费版超时
  const itemsToVerify = uniqueCandidates.slice(0, 40);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const isAlive = await verifyUrl(item.url);
      if (isAlive) {
        try {
          await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
          insertedCount++;
        } catch (e) { }
      }
    }));
  }
  console.log(`[cron] ✅ 本轮自动新增活站: ${insertedCount} 个`);

  // --- 自动更新 SEO 与分类修正 (保持不变) ---
  const { results: sitesToUpdate } = await DB.prepare(`
    SELECT id, url FROM sites WHERE description IN ('自动采集收录', '暂无描述', '') OR category_id = 7 LIMIT 15
  `).all();

  for (const site of sitesToUpdate) {
    try {
      const seoInfo = await fetchSeoInfo(site.url);
      if (seoInfo.title || seoInfo.description) {
        await DB.prepare(`UPDATE sites SET title = COALESCE(?, title), description = COALESCE(?, description), category_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(seoInfo.title || null, seoInfo.description || null, seoInfo.categoryId, site.id).run();
        console.log(`[cron] 📝 SEO更正: ${site.url} -> ${seoInfo.categoryId}`);
      }
    } catch (e) { }
  }
}

// ================== 各类采集引擎实现 ==================

// 1. RSS 采集
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

// 2. GitHub 搜索 API
async function collectGitHubRepos() {
  let items = [];
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=topic:bookmark&sort=stars&order=desc&per_page=5', { headers: { 'User-Agent': 'NavMap-Bot', 'Accept': 'application/vnd.github.v3+json' } });
    if (res.ok) {
      const data = await res.json();
      for (const repo of data.items) items.push({ url: repo.html_url, title: repo.name, description: repo.description || 'GitHub开源导航', categoryId: 5 });
    }
  } catch (e) {}
  return items;
}

// 3. 解析 Awesome 仓库 Markdown (宝藏提取)
async function collectAwesomeLists() {
  let items = [];
  // 目标仓库及其分类映射
  const repos = [
    { url: 'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md', cat: 5 },
    { url: 'https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md', cat: 5 }
  ];
  
  for (const repo of repos) {
    try {
      const text = await (await fetch(repo.url)).text();
      // 正则匹配 Markdown 链接格式：[标题](网址)
      const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
      let match;
      let count = 0;
      while ((match = regex.exec(text)) !== null && count < 15) {
        const title = match[1];
        const url = match[2];
        // 排除掉指向 github 自身的链接
        if (!url.includes('github.com')) {
          items.push({ url, title, description: 'Awesome开源精选', categoryId: repo.cat });
          count++;
        }
      }
    } catch (e) {}
  }
  return items;
}

// 4. Public APIs 接口库
async function collectPublicAPIs() {
  let items = [];
  try {
    const res = await fetch('https://api.publicapis.org/entries?https=true');
    if (res.ok) {
      const data = await res.json();
      // 随机抽取 10 个接口
      const entries = data.entries.sort(() => 0.5 - Math.random()).slice(0, 10);
      for (const entry of entries) {
        items.push({ url: entry.Link, title: entry.API, description: entry.Description || '公共API接口', categoryId: 5 });
      }
    }
  } catch (e) {}
  return items;
}

// 5. 网页 DOM 爬虫 (Trending 榜单)
async function collectWebScraping() {
  let items = [];
  try {
    const res = await fetch('https://github.com/trending?since=daily', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      await new HTMLRewriter().on('article.Box-row h2 a', {
        element(element) {
          const href = element.getAttribute('href');
          if (href) items.push({ url: `https://github.com${href}`, title: href.replace(/^\//, ''), description: 'GitHub 热门项目', categoryId: 5 });
        }
      }).transform(res).text();
    }
  } catch (e) {}
  return items;
}

// ================== 辅助工具 ==================

async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } });
    clearTimeout(timeoutId);
    return [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
  } catch (err) { return false; }
}

async function fetchSeoInfo(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.headers.get('content-type')?.includes('text/html')) return {};
    const html = await res.text();
    
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().replace(/\s+/g, ' ').substring(0, 50);

    let description = '';
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
    if (descMatch) description = descMatch[1].trim().replace(/\s+/g, ' ').substring(0, 150);

    const text = title + ' ' + description;
    let categoryId = 7; 
    if (/小说|阅读|文学|chapter|novel/i.test(text)) categoryId = 1;
    else if (/影视|电影|视频|剧|动漫|movie|tv/i.test(text)) categoryId = 2;
    else if (/音乐|歌|audio|music/i.test(text)) categoryId = 3;
    else if (/游戏|电竞|game|手游/i.test(text)) categoryId = 4;
    else if (/新闻|资讯|媒体|news/i.test(text)) categoryId = 6;
    else if (/工具|开发|下载|软件|科技|tool|api/i.test(text)) categoryId = 5;

    clearTimeout(timeoutId);
    return { title, description, categoryId };
  } catch (err) {
    clearTimeout(timeoutId);
    return {};
  }
}