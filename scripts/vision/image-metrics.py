# -*- coding: utf-8 -*-
"""本地可解释画面指标：拉普拉斯方差（清晰度）、亮度均值、对比度、字节熵。

用途：第 8 周的模型 confidence 恒为 1.0（实测 5 张真机图 + 4 张合成图全是 1.0），
不能当把握度用。这些指标是「可计算、可解释」的，用来：
  ① 判断画面是否根本不可用（全黑、纯色、极低对比度）
  ② 给模糊程度一个连续刻度，而不是二值标签
  ③ 与模型标签对照，暴露模型判错的情形

输出 JSON 到 stdout，供 Node 侧读取。
"""
import json
import math
import sys
from collections import Counter

from PIL import Image


def byte_entropy(path):
    with open(path, "rb") as f:
        data = f.read()
    c = Counter(data)
    n = len(data)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def metrics(path):
    with Image.open(path) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        gray = rgb.convert("L")
        # 用 tobytes() 而非已弃用的 getdata()：L 模式每像素 1 字节，结果等价且更快
        px = list(gray.tobytes())

    n = len(px)
    mean = sum(px) / n
    var = sum((p - mean) ** 2 for p in px) / n

    # 拉普拉斯方差：用 4 邻域卷积，衡量边缘强度
    lap = []
    for y in range(1, h - 1):
        row = y * w
        for x in range(1, w - 1):
            i = row + x
            v = 4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w]
            lap.append(v)
    lap_mean = sum(lap) / len(lap)
    lap_var = sum((v - lap_mean) ** 2 for v in lap) / len(lap)

    # 独特灰度级数：纯色图会很低
    levels = len(set(px))

    return {
        "path": path,
        "size": [w, h],
        "brightness_mean": round(mean, 2),
        "contrast_std": round(math.sqrt(var), 2),
        "laplacian_var": round(lap_var, 2),
        "gray_levels": levels,
        "byte_entropy": round(byte_entropy(path), 3),
    }


if __name__ == "__main__":
    out = [metrics(p) for p in sys.argv[1:]]
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
