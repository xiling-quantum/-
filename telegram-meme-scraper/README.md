# Telegram Meme Scraper

用于抓取公开 Telegram 频道 / 公开群组里的 meme 相关消息。实现方式是 `Telethon` + Telegram 官方客户端 API。

## 1. 申请 Telegram API 凭证

去 `https://my.telegram.org` 登录你的手机号，创建一个应用，拿到：

- `api_id`
- `api_hash`

这是 Telegram 官方客户端 API，不是 Bot Token。

## 2. 安装依赖

```powershell
cd d:\Vscode\telegram-meme-scraper
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 3. 配置环境变量

复制一份：

```powershell
Copy-Item .env.example .env
```

填写：

- `TG_API_ID`
- `TG_API_HASH`
- `TG_PHONE`

## 4. 配置抓取目标

复制一份：

```powershell
Copy-Item config.example.json config.json
```

修改 `config.json`：

- `channels`: 公开频道 / 公开群组用户名，或 `https://t.me/...` 链接
- `keywords`: meme 关键词
- `since_days`: 最近多少天
- `limit_per_channel`: 每个源最多扫描多少条消息
- `require_keyword_match`: 是否必须命中关键词
- `require_media`: 是否必须带图片 / 视频 / 文件

## 5. 运行

```powershell
python scrape_memes.py --config config.json
```

首次运行会要求登录 Telegram 账号，并可能要求输入验证码。完成后会在本地生成 session 文件，后续不需要重复登录。

## 6. 输出

默认输出到 `output/`：

- `telegram-memes-*.json`
- `telegram-memes-*.csv`

字段包括：

- `channel`
- `message_id`
- `date_utc`
- `matched_keyword`
- `has_media`
- `views`
- `forwards`
- `replies`
- `permalink`
- `text`

## 7. 使用边界

只建议用于：

- 你有权访问的公开频道 / 公开群组
- 合规的数据研究、监测、内容分析

不要用于绕过权限抓取私聊、私人群组或受限内容。
