#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract-mdcng-rules.py —— 从 mdc-ng 官方发布二进制提取内嵌刮削规则（升级用）

背景：javpaco 的 rules/mdc-ng/*.yaml 逐字取自 mdc-ng 官方二进制内嵌的
provider 规则（rust-embed 打包，每条规则是一段 raw-deflate 压缩的 YAML，
无文件名、无头部，首行是 name:）。mdc-ng 源码仓库不公开规则文件，
只能从二进制提取。javbus/javdb/mgstage/javlibrary 等源在 mdc-ng 里是
Rust 硬编码刮削器，不在内嵌 YAML 之列（内嵌就这几条：本脚本输出的清单）。

用法：
  1. 到 https://github.com/mdc-ng/mdc-ng/releases 下载新版二进制
     （linux_amd64 / linux_arm64 均可，内嵌数据相同）
  2. python3 extract-mdcng-rules.py <二进制路径> [输出目录，默认覆盖 ../rules/mdc-ng]
  3. 比对输出与旧规则 diff，确认无回归后随版本提交

依赖：pip install pyyaml
提取原理（两阶段）：
  阶段1 并行预扫：逐偏移探测 raw-deflate 流头（首字节 BFINAL=1 且
        BTYPE∈{固定,动态}），喂 96 字节解出前 120B，含 name: 即为候选；
  阶段2 串行精解：候选偏移全量解压，必须能被 yaml 解析且含 name 字段，
        按流边界（unused_data）跳过整条流避免同流重复。
"""
import os, sys, zlib
from multiprocessing import Pool

try:
    import yaml
except ImportError:
    sys.exit('需要 pyyaml：pip install pyyaml')

BIN = sys.argv[1] if len(sys.argv) > 1 else 'mdc_ng_app_linux_amd64'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'rules', 'mdc-ng')

_G = {}

def _init(data):
    _G['data'] = data

def _preview(args):
    lo, hi = args
    data = _G['data']
    hits = []
    for i in range(lo, hi):
        b = data[i]
        if (b & 6) not in (2, 4):   # BTYPE=动态(10)或固定(01)；BFINAL 任意（大文件首块常为非终结块）
            continue
        try:
            d = zlib.decompressobj(-15)
            out = d.decompress(data[i:i + 512], 120)
            # 高压缩率的大规则（DMM/Jav321/AVbase）前 96 字节只解得出 'nam'，必须宽松
            if len(out) >= 3 and b'nam' in out[:8]:
                hits.append(i)
        except Exception:
            continue
    return hits


def main():
    data = open(BIN, 'rb').read()
    n = len(data)
    workers = os.cpu_count() or 8
    chunk = n // workers + 1
    tasks = [(s, min(s + chunk, n)) for s in range(0, n, chunk)]
    print(f'阶段1：预扫 {n} 字节（{workers} 进程）...', flush=True)
    with Pool(workers, initializer=_init, initargs=(data,)) as p:
        cands = sorted(set(sum(p.map(_preview, tasks), [])))
    # 相邻候选合并（同一流的多次命中）
    merged = []
    for o in cands:
        if merged and o - merged[-1] < 64:
            continue
        merged.append(o)
    print(f'阶段1 完成：候选流 {len(merged)} 个', flush=True)

    print('阶段2：全量解压 + YAML 校验...', flush=True)
    os.makedirs(OUT, exist_ok=True)
    got = {}
    i_pos = 0
    while i_pos < len(merged):
        o = merged[i_pos]
        try:
            d = zlib.decompressobj(-15)
            out = d.decompress(data[o:n]) + d.flush()
            doc = yaml.safe_load(out)
            assert isinstance(doc, dict) and 'name' in doc
        except Exception:
            i_pos += 1
            continue
        consumed = (n - o) - len(d.unused_data)
        name = str(doc['name']).replace('/', '_')
        if name not in got or len(out) > len(got[name][1]):
            got[name] = (o, out)
        print(f'  @0x{o:08x} raw={len(out):6d}  {name}')
        # 跳过被本流覆盖的后续候选
        while i_pos < len(merged) and merged[i_pos] < o + consumed:
            i_pos += 1
    for name, (_, out) in got.items():
        open(os.path.join(OUT, name + '.yaml'), 'wb').write(out)
    print(f'\n共提取 {len(got)} 条规则 -> {os.path.abspath(OUT)}')
    print('规则清单：', ', '.join(sorted(got)))


if __name__ == '__main__':
    main()
