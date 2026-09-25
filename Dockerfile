# JAVPACO 迷你媒体服务 —— 零构建依赖，直接用官方 Node 镜像
# 精简版：头像库不进镜像（server.js 头像在线兜底按需抓取，落盘 cache/actors/）；
# cache/ 单层整拷（多目录 COPY 会拍平互相覆盖，见下）。
FROM node:22-alpine

# ffmpeg/ffprobe：进度条缩略图抽帧用
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 只拷贝需要的文件（媒体目录通过卷挂载，不进镜像）
COPY index.html server.js mdcng.js hls.light.min.js package.json package-lock.json ./
COPY rules ./rules
COPY covers ./covers
COPY manifest.webmanifest sw.js icon-192.png icon-512.png apple-touch-icon.png favicon.ico ./

# 刮削规则引擎的 npm 依赖（js-yaml/jsdom/xpath/jpeg-js，见 package.json）
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# 内置女优资料（netflav 抓取 + minnano 同步）：资料库 + 头像 + 名字归一化/别名表 + 排行榜/标签翻译
COPY actresses.json name-map.json name-alias.json rankings.json tags-zh.json actresses-extra.json ./

# 头像库（actresses/，957MB）已改为在线按需抓取，不再 COPY 进镜像。
# 影片示例数据（离线资料库）：cache/movies/<番号>/（meta.json+封面/剧照）+ 头像缓存。
# 注意：不能用「COPY cache/movies/A cache/movies/B ./cache/movies/」多目录源写法——
# Docker 对多目录源会把目录内容拍平合并，141 个影片互相覆盖只剩最后一个！
# 整目录单源拷贝才是正确的（135MB 单层，弱网推送时耐心磨）。
COPY cache ./cache
# 个人数据（server-config.json / watch.json / userdata.json / media-path.txt）已被 .dockerignore 排除。

ENV PORT=8090
EXPOSE 8090

# /app/cache 声明为卷：不映射时 Docker 自动建卷并拷入示例数据；映射后用宿主目录
VOLUME ["/media", "/app/cache"]

# 容器内媒体固定挂载在 /media
CMD ["node", "server.js", "/media", "8090"]
