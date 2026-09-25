#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 name-map.json —— 字符级「繁体/日文异体 → 简体」对照表。

用途：媒体库 NFO 里的女优名多为简体（如「朝比奈七濑」），
netflav 多为日文/繁体（「朝比奈七瀬」）。前端用同一张字符表归一化两边，
即可稳定匹配。

数据源：zhconv 的转换表 + 手工补充的日文专用异体字。
输入：actresses.json（netflav 女优名）+ 可选的库内演员名列表
输出：nexdex-ui/name-map.json
"""
import json
import os
import sys

sys.path.insert(0, '/tmp/zhconv-1.4.3')
from zhconv import convert  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 日文专用异体字（zhconv 不覆盖，手工补）
EXTRA = {
    '瀬': '濑', '戸': '户', '冨': '富', '徳': '德', '曽': '曾', '栄': '荣',
    '絵': '绘', '恵': '惠', '沢': '泽', '浜': '滨', '廣': '广', '國': '国',
    '與': '与', '齊': '齐', '齋': '斋', '藪': '薮', '邊': '边', '彌': '弥',
    '壽': '寿', '峯': '峰', '嶋': '岛', '嶌': '岛', '巖': '岩', '觸': '触',
    '曄': '晔', '驛': '驿', '橫': '横', '鯨': '鲸', '﨑': '崎',
    '鹽': '盐', '條': '条', '絲': '丝', '淨': '净', '薗': '园',
    '凜': '凛', '篭': '笼', '眞': '真', '桜': '樱', '歩': '步', '筿': '筱',
    '莎': '莎', '纚': '纚', '聖': '圣', '麗': '丽', '織': '织', '優': '优',
    '櫻': '樱', '亜': '亚', '来': '来', '楽': '乐', '悪': '恶', '価': '价',
    '駅': '驿', '鋭': '锐', '闇': '闇', '鞍': '鞍', '綾': '绫', '杏': '杏',
}
# 只保留真的发生了变化的条目
EXTRA = {k: v for k, v in EXTRA.items() if k != v}


def collect_names():
    names = set()
    src = os.path.join(ROOT, 'actresses.json')
    if os.path.exists(src):
        for rec in json.load(open(src, encoding='utf-8')):
            for f in ('name', 'name_ja', 'name_zh', 'name_en'):
                v = rec.get(f)
                if v:
                    names.add(v)
    # 额外补充（库存演员名，可选）
    extra = os.path.join(ROOT, 'tools', 'extra-names.txt')
    if os.path.exists(extra):
        for line in open(extra, encoding='utf-8'):
            line = line.strip()
            if line:
                names.add(line)
    return names


def main():
    names = collect_names()
    chars = set()
    for n in names:
        chars.update(n)
    mapping = {}
    for ch in chars:
        if ch in EXTRA:
            mapping[ch] = EXTRA[ch]
            continue
        c = convert(ch, 'zh-cn')
        if len(c) == 1 and c != ch:
            mapping[ch] = c
    out = os.path.join(ROOT, 'name-map.json')
    json.dump(mapping, open(out, 'w', encoding='utf-8'), ensure_ascii=False, sort_keys=True)
    print(f'扫描 {len(names)} 个名字 / {len(chars)} 个字符 → 生成 {len(mapping)} 条映射 → {out}')
    for k in list(mapping)[:20]:
        print(' ', k, '→', mapping[k])


if __name__ == '__main__':
    main()
