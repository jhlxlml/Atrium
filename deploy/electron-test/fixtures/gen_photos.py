# -*- coding: utf-8 -*-
"""生成 Electron 自测用的可解码 PNG 图库（纯标准库，含子目录递归与干扰文件）。"""
import os, struct, zlib

ROOT = r"D:\AIwork\2026-09-07-08-46-14\deploy\electron-test\照片夹"

def png_bytes(w, h, rgb, name_tag):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    # 每行：filter 0 + 一行像素（纯色 + 顶部一条强调色带，便于目视区分）
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            if y < max(2, h // 8):
                px = (min(255, rgb[0] + 60), min(255, rgb[1] + 60), min(255, rgb[2] + 60))
            else:
                px = rgb
            raw += bytes(px)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))

def write(folder, name, w, h, rgb):
    os.makedirs(folder, exist_ok=True)
    p = os.path.join(folder, name)
    with open(p, "wb") as f:
        f.write(png_bytes(w, h, rgb, name))
    os.utime(p, (1700000000, 1700000000))
    return p

def main():
    os.makedirs(ROOT, exist_ok=True)
    files = []
    # 根目录 5 张
    files.append(write(ROOT, "山景-01.png", 800, 533, (120, 150, 110)))
    files.append(write(ROOT, "海景-02.png", 640, 480, (90, 140, 180)))
    files.append(write(ROOT, "日落-03.png", 960, 640, (210, 120, 70)))
    files.append(write(ROOT, "街道-04.png", 533, 800, (160, 130, 100)))
    files.append(write(ROOT, "雪景-05.png", 1200, 800, (190, 200, 215)))
    # 子目录 2 张（测递归）
    sub = os.path.join(ROOT, "子集")
    files.append(write(sub, "子集-A.png", 700, 700, (140, 90, 150)))
    files.append(write(sub, "子集-B.png", 900, 600, (60, 160, 130)))
    # 干扰文件（应被过滤）
    junk = os.path.join(ROOT, "说明.txt")
    with open(junk, "w", encoding="utf-8") as f:
        f.write("not an image\n")
    os.utime(junk, (1700000000, 1700000000))
    print("generated", len(files), "png files under", ROOT)
    for p in files:
        print(" ", os.path.relpath(p, ROOT))

if __name__ == "__main__":
    main()
