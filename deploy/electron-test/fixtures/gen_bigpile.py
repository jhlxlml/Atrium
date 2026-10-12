import os, struct, zlib
out = "bigpile"
os.makedirs(out, exist_ok=True)
def png(path, w, h, rgb):
    raw = b''
    for y in range(h):
        raw += b'\x00' + bytes(rgb)*(w)
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))
n = 850
for i in range(n):
    r = (i*7) % 256; g = (i*13) % 256; b = (i*29) % 256
    png(os.path.join(out, f"img_{i:04d}.png"), 8, 8, (r,g,b))
print("generated", n, "images in", out)
