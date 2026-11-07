#!/usr/bin/env bash
# HTTP 接口的最小示例：先 `node server.mjs --port 7474`，再跑这个。
set -e
B=http://127.0.0.1:7474

echo '--- 统计'
curl -s "$B/api/stats"; echo

echo '--- 检索'
curl -s "$B/api/recall?q=%E7%AA%97%E5%8F%A3%E9%97%AA%E7%83%81&limit=3"; echo

echo '--- 写一条事实'
curl -s -X POST "$B/api/fact" -H 'content-type: application/json' \
  -d '{"subject":"dsh-context-rotate","aliases":["轮转式上下文插件","轮转的插件"],"note":"上下文轮转插件，仓库 CQMX721"}'; echo

echo '--- 记一条决策'
curl -s -X POST "$B/api/decide" -H 'content-type: application/json' \
  -d '{"decision":"检索不到时先反问","reason":"硬猜一次的代价比问一句大得多"}'; echo

echo '--- 档案列表'
curl -s "$B/api/memory"; echo
