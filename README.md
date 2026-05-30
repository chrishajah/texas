# 德州扑克私人牌桌

React/Vite + Express/Socket.IO 的德州扑克联机 MVP。房间状态保存在服务器内存中，玩家通过 `/room/:roomId` 链接和昵称加入，筹码仅用于娱乐。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`，创建房间后复制房间链接给朋友。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## 生产启动

```bash
npm run build
npm start
```

服务会读取平台提供的 `PORT` 环境变量，适合部署到 Render、Railway、Fly.io 等支持 WebSocket 的 Node 平台。

## 部署到公网

推荐先用 Render 或 Railway，因为这个项目是单个 Node Web Service，不需要把前端和后端分开部署。

### Render

1. 把项目推到 GitHub。
2. 在 Render 里新建 `Web Service`，连接这个仓库。
3. 设置：
   - Runtime: `Node`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment Variable: `NODE_ENV=production`
4. 部署完成后，打开 Render 给你的 `https://...onrender.com` 地址。
5. 在首页创建房间，把 `/room/:roomId` 链接发给朋友。

### Railway

1. 把项目推到 GitHub。
2. 在 Railway 里选择 `Deploy from GitHub repo`。
3. Railway 会自动识别 Node 项目；如需手动设置：
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment Variable: `NODE_ENV=production`
4. 部署后使用 Railway 生成的公开域名访问。

### 注意

- 必须部署成 Web Service/Node 服务，不要部署成 Static Site，因为游戏依赖 Socket.IO WebSocket。
- 免费实例可能会休眠，朋友第一次打开可能要等服务唤醒。
- 当前版本房间存在内存里，服务重启或重新部署会清空正在玩的房间。

## 当前限制

- 无账号、无数据库、无大厅和长期战绩。
- 服务器重启会清空房间。
- 筹码没有现金价值，不支持充值或提现。
