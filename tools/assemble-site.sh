#!/usr/bin/env bash
# 部署产物的唯一清单。pages.yml 调它，本地闸（tools/deploy-set.mjs）也调它。
#
# 为什么要抽出来：这个仓没有打包器，站点=一次文件拷贝，而"拷哪些"以前写在 workflow 的
# run: 里。本地 index.html 直读仓库根，永远是对的；CI 却按那份手写清单拷。清单落后于
# 页面时，上线的站点就会缺文件（favicon/manifest/sw.js 全 404），而仓里的引擎测试与浏览器
# 闸一条都不会红——它们跑的都是仓库根，没有任何一步在"清单只拷三个路径"的那个环境下加载过页面。
# 现在清单只有一份：改了页面没改这里，本地跑 `node tools/deploy-set.mjs` 就红。
#
# 用法：tools/assemble-site.sh <目标目录>     （目标目录必须不存在或为空）
set -u
DEST=${1:?usage: tools/assemble-site.sh <dest-dir>}
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE" || exit 2
[ -d "$DEST" ] || mkdir -p "$DEST" || { echo "cannot create $DEST" >&2; exit 2; }

# 进站点的：玩家浏览器会去要的东西，一个都不落。
cp index.html manifest.webmanifest sw.js "$DEST/"
cp -r css js "$DEST/"
# 位图目录：icons/ 是图标与 apple-touch-icon。assets/ 下**只有** textures/ 与 img/ 是运行时
# 真要的（盘面纹理、社交卡、品牌 sprite）；gen/ 是 Python 出图脚本、manifest.json 是它的
# 清单——两者都不进站点：tools/verify.sh 的部署形状腿正反着查 assets/gen/gen_art.py 必须 404，
# 而把整个 assets/ 拷上去就正好把它递出去了。
for d in icons; do
  [ -d "$d" ] && cp -r "$d" "$DEST/"
done
mkdir -p "$DEST/assets"
for d in textures img; do
  [ -d "assets/$d" ] && cp -r "assets/$d" "$DEST/assets/"
done

# 不进站点的（有意为之，别"顺手加上"）：
#   server.cjs / electron/     本地与桌面形态的宿主，浏览器用不到，传上去只是把源码摊开
#   tools/                     闸与台架
#   README.md DESIGN.md        给组织的文档
#   package.json               站点不读它；带上只会让 Pages 多一个可访问的依赖清单
#   _tmp-*                     跑闸留下的日志
exit 0
