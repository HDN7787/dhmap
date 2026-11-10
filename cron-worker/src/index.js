export default {
  async scheduled(event, env, ctx) {
    console.log('[cron] ⏰ 定时任务触发，时间:', new Date().toISOString());
    ctx.waitUntil(runAutomatedPipeline(env));
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 终极全引擎采集执行完毕，请查看后台。', { status: 200 });
    }
    return new Response('导航map 自动引擎运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('[cron] 缺少 D1 绑定');

  console.log('[cron] 🚀 开始执行终极全火力采集...');
  let allCandidateItems = [];

  // --- 引擎 1：超大规模 RSS 矩阵 ---
  try { allCandidateItems.push(...await collectRSS()); } catch (e) { }
  
  // --- 引擎 2：GitHub API 搜索 ---
  try { allCandidateItems.push(...await collectGitHubRepos()); } catch (e) { }
  
  // --- 引擎 3：GitHub Awesome 宝藏库矩阵 ---
  try { allCandidateItems.push(...await collectAwesomeLists()); } catch (e) { }

  // --- 引擎 4：Public APIs 接口库 ---
  try { allCandidateItems.push(...await collectPublicAPIs()); } catch (e) { }

  // --- 引擎 5：网页 DOM 爬虫 (GitHub Trending) ---
  try { allCandidateItems.push(...await collectWebScraping()); } catch (e) { }

  // --- 引擎 6：外部优质导航 JSON 源 ---
  try { allCandidateItems.push(...await collectExternalNavs()); } catch (e) { }

  // --- 统一去重与验证 ---
  const uniqueCandidates = [];
  const seenDomains = new Set();
  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    let hostname = '';
    try {
      const u = new URL(item.url);
      hostname = u.hostname.replace(/^www\./, '');
      // 过滤掉 github 自身、本地域名和无效域名
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

  console.log(`[cron] 🎯 去重后获得 ${uniqueCandidates.length} 个新域名，准备验证...`);

  // 拉高单次限制到 100，并发池每次 10 个（极速且防超时）
  const itemsToVerify = uniqueCandidates.slice(0, 100);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 10) {
    const batch = itemsToVerify.slice(i, i + 10);
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
  console.log(`[cron] ✅ 本轮终极采集新增活站: ${insertedCount} 个`);

  // --- 自动更新 SEO 与分类 (修正最近入库的 20 个) ---
  const { results: sitesToUpdate } = await DB.prepare(`
    SELECT id, url FROM sites WHERE description IN ('自动采集收录', '暂无描述', '') OR category_id = 7 ORDER BY id DESC LIMIT 20
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

// ================== 1. 超大规模 RSS 矩阵 ==================
async function collectRSS() {
  const feeds = [
    { url: 'https://sspai.com/feed', cat: 5 },
    { url: 'https://www.ithome.com/rss/', cat: 6 },
    { url: 'https://www.ifanr.com/feed', cat: 6 },
    { url: 'https://rsshub.app/zhihu/hotlist', cat: 6 },
    { url: 'https://rsshub.app/github/trending/daily/any', cat: 5 },
    { url: 'https://www.v2ex.com/index.xml', cat: 5 },
    { url: 'https://www.geekpark.net/rss', cat: 6 },
    { url: 'https://www.huxiu.com/rss/0.xml', cat: 6 }
  ];
  let items = [];
  for (const feed of feeds) {
    try {
      const xml = await (await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        // 过滤掉 RSS 本身的链接
        if (!match[1].includes('.xml') && match[1] !== feed.url && !match[1].includes('rsshub.app')) {
          items.push({ url: match[1], title: '最新资讯', description: 'RSS资讯', categoryId: feed.cat });
        }
      }
    } catch (e) {}
  }
  return items;
}

// ================== 2. GitHub 搜索 API ==================
async function collectGitHubRepos() {
  let items = [];
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=topic:bookmark&sort=stars&order=desc&per_page=10', { headers: { 'User-Agent': 'NavMap-Bot', 'Accept': 'application/vnd.github.v3+json' } });
    if (res.ok) {
      const data = await res.json();
      for (const repo of data.items) {
        items.push({ url: repo.html_url, title: repo.name, description: repo.description || 'GitHub开源导航', categoryId: 5 });
      }
    }
  } catch (e) {}
  return items;
}

// ================== 3. GitHub Awesome 宝藏库矩阵 ==================
async function collectAwesomeLists() {
  let items = [];
  const repos = [
    { url: 'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md', cat: 5 },
    { url: 'https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md', cat: 5 },
    { url: 'https://raw.githubusercontent.com/enaqx/awesome-react/master/README.md', cat: 5 },
    { url: 'https://raw.githubusercontent.com/vinta/awesome-python/master/README.md', cat: 5 },
    { url: 'https://raw.githubusercontent.com/awesome-foss/awesome-sysadmin/master/README.md', cat: 5 }
  ];
  
  for (const repo of repos) {
    try {
      const text = await (await fetch(repo.url)).text();
      // 正则匹配 Markdown 链接格式：[标题](网址)
      const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
      let match;
      let count = 0;
      // 每个库提取 20 个
      while ((match = regex.exec(text)) !== null && count < 20) {
        const title = match[1];
        const url = match[2];
        // 排除掉指向 github、图片等无效链接
        if (!url.includes('github.com') && !url.includes('badge') && !url.includes('img.shields.io')) {
          items.push({ url, title, description: 'Awesome开源精选', categoryId: repo.cat });
          count++;
        }
      }
    } catch (e) {}
  }
  return items;
}

// ================== 4. Public APIs 接口库 ==================
async function collectPublicAPIs() {
  let items = [];
  try {
    const res = await fetch('https://api.publicapis.org/entries?https=true');
    if (res.ok) {
      const data = await res.json();
      // 随机抽取 50 个
      const entries = data.entries.sort(() => 0.5 - Math.random()).slice(0, 50);
      for (const entry of entries) {
        items.push({ url: entry.Link, title: entry.API, description: entry.Description || '公共API接口', categoryId: 5 });
      }
    }
  } catch (e) {}
  return items;
}

// ================== 5. 网页 DOM 爬虫 (Trending 榜单) ==================
async function collectWebScraping() {
  let items = [];
  try {
    const res = await fetch('https://github.com/trending?since=weekly', { headers: { 'User-Agent': 'Mozilla/5.0' } });
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

// ================== 6. 外部优质导航 JSON 源 ==================
async function collectExternalNavs() {
  let items = [];
  try {
    // 这是一个公开的前端开发者导航 JSON 数据源
    const res = await fetch('https://raw.githubusercontent.com/jaywcjlove/FED/master/data.json');
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.sites || []);
      for (const item of list) {
        if (item.url) items.push({ url: item.url, title: item.name, description: item.des || '', categoryId: 5 });
      }
    }
  } catch (e) {}
  return items;
}

// ================== 辅助工具：验证与 SEO 提取 ==================

async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    // 极速验证：5秒超时
    const timeoutId = setTimeout(() => controller.abort(), 5000);
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