# -*- coding: utf-8 -*-
"""生成灯箱性能测试用的图库（纯标准库，无第三方依赖）。

为什么要"渐变 + 每行错位"的图案，而不是纯色：
  纯色 PNG 压缩后只有几十 KB，zlib 解压几乎不花时间 —— 量出来的"解码耗时"
  会比真实照片低一个数量级，A/B 对比也就失去意义。这里让每行的色带起点
  逐行偏移，压缩率落在"几 MB"的量级，inflate + 反滤波的开销与真实照片
  同量级（仍是 PNG，比 JPEG 的 IDCT 便宜，但足够把 24MP/48MP 的差距拉出来）。

用法：
  python gen_mp.py <输出目录>

生成：
  <输出目录>/mp12/      12 张 6000×4000（24MP）
  <输出目录>/mp48/      1 张 8000×6000（48MP）+ 4 张 6000×4000
  <输出目录>/pile1000/  1000 张 800×600（模拟"大文件夹"）
"""
import os
import struct
import sys
import zlib


def png_bytes(w, h, seed):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    # 一行基础像素：横向渐变，色相随 seed 变化
    base = bytearray(w * 3)
    r0 = (seed * 37) % 200
    g0 = (seed * 71) % 200
    b0 = (seed * 113) % 200
    for x in range(w):
        t = x / max(1, w - 1)
        base[x * 3] = (r0 + int(55 * t)) % 256
        base[x * 3 + 1] = (g0 + int(35 * t)) % 256
        base[x * 3 + 2] = (b0 + int(75 * t)) % 256

    raw = bytearray()
    for y in range(h):
        # 每行左移一个与 y 相关的偏移 → 压缩率不会掉到"纯色"那一档
        off = (y * 3) % (w * 3)
        raw.append(0)                      # filter type 0
        if off:
            raw += base[off:] + base[:off]
        else:
            raw += base
        if y % 97 == 0:                    # 稀疏的深色横条，进一步降低可压缩性
            raw[-3:] = b"\x00\x00\x00"

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def write(path, w, h, seed):
    data = png_bytes(w, h, seed)
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    jobs = [
        ("mp12", [(6000, 4000)] * 12),
        ("mp48", [(8000, 6000)] + [(6000, 4000)] * 4),
        ("pile1000", [(800, 600)] * 1000),
    ]
    for folder, specs in jobs:
        d = os.path.join(out, folder)
        os.makedirs(d, exist_ok=True)
        total = 0
        for i, (w, h) in enumerate(specs):
            total += write(os.path.join(d, "p%03d.png" % i), w, h, i + 1)
        print("%-10s %4d 张 %8.1f MB  -> %s" % (folder, len(specs), total / 1048576.0, d))


if __name__ == "__main__":
    main()
