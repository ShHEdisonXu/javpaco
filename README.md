# JAVPACO · 迷你影片媒体库

单文件 Node.js 媒体库服务：番号识别、元数据刮削、演员/系列/榜单聚合、MissAV 应用内在线播放。零构建依赖，`node server.js` 直接跑，官方 Node 镜像直接 `docker build`。

> 自用项目，界面与示例数据均为中文向。请自行遵守所在地区法律法规，仅用于管理个人合法获取的媒体文件。

## 快速开始

```bash
# 源码运行（Node 18+，需要 ffmpeg 在 PATH 里做缩略图）
npm ci --omit=dev
node server.js /path/to/media 8090

# Docker
docker build -t javpaco .
docker run -d --name javpaco -p 8090:8090 \
  -v /path/to/media:/media \
  -v /path/to/cache:/app/cache \
  javpaco
```

参照 `docker-compose.example.yml` 修改路径即可。

## 目录约定

| 路径 | 说明 |
|---|---|
| `/media`（或启动参数） | 媒体目录，按 `番号/` 或 `番号.mp4` 组织 |
| `/app/cache` | 离线刮削缓存 `cache/movies/<番号>/meta.json`，重建容器不丢元数据 |

**仓库不含** `cache/`（134MB 示例元数据）与 `actresses/`（957MB 头像库），首次部署后把这两份放到对应目录即可获得完整体验；不放也能跑，首扫会自动生成/刮削。

## 主要功能

- 番号识别（横杠/无横杠/日期式无码），扫库增量执行，失败自动进待处理列表
- 扫描后自动刮削新番号、每日定时重扫（设置 → 刮削与整理，可关）
- MissAV 应用内播放：导航站线路发现 + 镜像健康度 + HLS 中转重写（hls.js）
- 演员聚合页、系列、榜单（每日自动更新）、收藏/订阅/隐藏
- 搜索：1~2 字符短关键词只搜番号与演员名，3 字符起全文
- 115 网盘挂载目录直接作媒体库；代理可视化配置
- server-config.json 一键备份/恢复（含白名单字段）

## 相关文件

- `rules/mdc-ng/` 刮削规则引擎的规则集
- `tools/` 演员资料/别名同步等辅助脚本
- `tags-zh.json`、`name-map.json`、`rankings.json` 内置中文标签映射与榜单种子数据
