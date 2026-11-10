导航map - 全自动网址导航站构建与部署文档
本项目是一个基于 Cloudflare 生态（Pages + Workers + D1）构建的全自动、高性能、免服务器的网址导航站。具备自动采集、存活性验证、二级域名收录、智能分类、用户投稿和管理后台等完整功能。

📌 目录
技术架构与准备工作

数据库设计与初始化

前端页面代码 (Pages)

后端 API 代码 (Pages Functions)

自动化采集 Worker 代码

项目部署与上线流程

SEO 优化与搜索引擎收录

避坑指南 (FAQ)

一、技术架构与准备工作
1.1 技术栈
前端与 API：Cloudflare Pages (静态托管 + Pages Functions)

主数据库：Cloudflare D1 (Serverless SQLite)

定时采集：Cloudflare Workers (Cron Triggers)

UI 风格：原生 CSS (玻璃拟态、响应式网格布局)

1.2 准备工作
注册 Cloudflare 账号。

注册 GitHub 账号，用于代码托管与自动部署。

本地安装 Node.js (v18+) 和 Git。

在 VS Code 终端中安装 Wrangler：

bash
npm install -g wrangler
npx wrangler login
二、数据库设计与初始化
在终端执行以下命令创建 D1 数据库：

bash
npx wrangler d1 create nav-site-db
记录下终端返回的 database_id，稍后在 wrangler.toml 中用到。

2.1 完整建表 SQL (schema.sql)
sql
-- 分类表
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO categories (id, name, slug, sort_order) VALUES
(1, '小说', 'novel', 1), (2, '影视', 'movie', 2), (3, '音乐', 'music', 3),
(4, '游戏', 'game', 4), (5, '工具', 'tool', 5), (6, '新闻', 'news', 6), (7, '其他', 'other', 7);

-- 已收录网址表
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  registrable_domain TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER NOT NULL REFERENCES categories(id),
  status TEXT NOT NULL DEFAULT 'active',
  click_rank_24h INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
);

-- 投稿流水表
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 插入系统机器人账号 (用于自动采集记录流水)
INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (999, 'system@navmap.local', 'system');
执行建表：

bash
npx wrangler d1 execute nav-site-db --remote --file=./schema.sql
三、前端页面代码 (Pages)
在项目根目录创建 public 文件夹。

3.1 public/index.html (首页)
核心亮点：SEO 友好、响应式网格、玻璃拟态卡片、国内极速图标接口（含首字母兜底）。
(由于代码较长，请复制历史记录中最新版的 index.html，包含 api.iowen.cn 图标加载及 grid-template-columns 强制布局代码)

3.2 public/detail.html (站点详情页)
(略：单站点详情展示，包含跳转按钮)

3.3 public/admin.html (管理后台)
核心亮点：双 Tab 切换（流水日志 / 站点管理），支持修改、下架、上架。

四、后端 API 代码 (Pages Functions)
在项目根目录创建 functions 文件夹。

4.1 获取分类 (functions/api/categories.js)
javascript
export async function onRequest(context) {
  const { env } = context;
  const { results } = await env.DB.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
4.2 获取站点列表 (functions/api/sites.js)
javascript
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const categorySlug = url.searchParams.get('category');
  const q = url.searchParams.get('q');
  const page = parseInt(url.searchParams.get('page')) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize')) || 18;
  const offset = (page - 1) * pageSize;

  let sql = '', params = [];
  if (q) {
    sql = `SELECT s.*, c.name AS category_name FROM sites s JOIN categories c ON c.id = s.category_id WHERE s.status = 'active' AND (s.title LIKE ? OR s.description LIKE ?) ORDER BY s.click_rank_24h DESC LIMIT 50`;
    params = [`%${q}%`, `%${q}%`];
  } else if (categorySlug) {
    sql = `SELECT s.*, c.name AS category_name FROM sites s JOIN categories c ON c.id = s.category_id WHERE c.slug = ? AND s.status = 'active' ORDER BY s.click_rank_24h DESC LIMIT ? OFFSET ?`;
    params = [categorySlug, pageSize, offset];
  }
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
4.3 热门排行 (functions/api/sites/top.js)
javascript
export async function onRequest(context) {
  const { env } = context;
  // 直接按点击量降序抽取 12 个
  const sql = `SELECT s.*, c.name AS category_name FROM sites s JOIN categories c ON c.id = s.category_id WHERE s.status = 'active' ORDER BY s.click_rank_24h DESC, RANDOM() LIMIT 12`;
  const { results } = await env.DB.prepare(sql).all();
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
五、自动化采集 Worker 代码
5.1 初始化 Worker
创建 cron-worker 文件夹，新建 wrangler.toml：

toml
name = "nav-site-cron"
main = "src/index.js"
compatibility_date = "2026-11-09"

[[d1_databases]]
binding = "DB"
database_name = "nav-site-db"
database_id = "你的数据库ID"

[triggers]
crons = ["0 */6 * * *"] # 每 6 小时自动跑一次

[observability]
enabled = true
5.2 采集逻辑 (cron-worker/src/index.js)
(请复制历史记录中最新的“无差别抓取+智能净化+SEO抓取”版本代码，包含 Awesome、RSS 抓取及黑名单过滤机制)

六、项目部署与上线流程
6.1 推送到 GitHub
bash
git init
git add .
git commit -m "init project"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
6.2 Cloudflare Pages 绑定
在 Cloudflare 控制台进入 Workers & Pages -> Create application -> Pages -> Connect to Git。

选择你的仓库，填写配置：

Framework preset: None

Build command: 留空

Build output directory: public

点击 Save and Deploy。

6.3 配置环境变量 (Secrets)
在 Pages 项目 -> Settings -> Environment variables (Production 环境) 添加：

JWT_SECRET: (随机字符串)

TURNSTILE_SECRET: (人机验证密钥)

6.4 部署 Worker
bash
cd cron-worker
npx wrangler deploy
七、SEO 优化与搜索引擎收录
Sitemap 自动生成：在 functions/sitemap.xml.js 中，实时读取数据库生成 XML。

静态化详情页：通过 functions/site/[id].js 实现边缘 SSR 渲染。

提交搜索引擎：

必应 (Bing)：使用 HTML 元标签验证（<meta name="msvalidate.01" ...>）。

百度：需绑定独立域名并在站长平台提交。

流量统计：集成 Microsoft Clarity 进行用户行为分析。

八、避坑指南 (FAQ)
🚨 Git 卡在 Vim 编辑器（黑框）
现象：输入 git commit 后弹出一个满是波浪号 ~ 的黑框，无法输入。
解决：按键盘 Esc，然后依次输入 :wq，按回车即可保存退出。

🚨 Git 提示 no changes added to commit
现象：执行了 git commit 但报错。
解决：必须先执行 git add .，再执行 git commit，最后 git push。三步缺一不可。

🚨 Worker 运行超时 / 采集数量为 0
原因：免费版 Worker 限制单次 fetch 请求不能超过 50 次，且 CPU 时间只有 10ms。
解决：代码中已加入 slice(0, 30) 限制并发数，每次只处理 30 个；若仍报错，需减少单次处理量。

🚨 网站图标全是白板
原因：Google 的 Favicon 接口被墙。
解决：替换为 https://api.iowen.cn/favicon/${domain}.png，且前端加入了首字母兜底逻辑。

🚨 网页排版不对称 (3个、9个孤零零)
解决：将接口返回限制改为 12 个，并在 CSS 中使用媒体查询 grid-template-columns: repeat(4, 1fr) 强制列数。

