@echo off
cd /d D:\Vscode\social-hotlist-scraper
set DASHBOARD_PORT=47831
npm run daily:feishu -- --config ./config/sources.example.json --platform all >> D:\Vscode\social-hotlist-scraper\daily-collect.log 2>&1
