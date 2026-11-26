"""生成应用图标：紫罗兰圆角底 + 白色声波条。"""
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 圆角方形渐变底（逐行插值）
top = (139, 108, 255)
bottom = (88, 56, 226)
radius = 224
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=radius, fill=255)
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    gd.line([(0, y), (S, y)], fill=c + (255,))
img = Image.composite(grad, img, mask)

# 顶部柔光
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((-300, -600, S + 300, 380), fill=(255, 255, 255, 40))
from PIL import ImageFilter

glow = glow.filter(ImageFilter.GaussianBlur(140))
img = Image.alpha_composite(img, glow)
img.putalpha(mask)

# 声波条：五根白色圆头竖条，按高度比例居中
d = ImageDraw.Draw(img)
bar_w = 92
gap = 46
heights = [300, 452, 560, 452, 300]
total = bar_w * len(heights) + gap * (len(heights) - 1)
x = (S - total) / 2
for h in heights:
    y0 = (S - h) / 2
    d.rounded_rectangle((x, y0, x + bar_w, y0 + h), radius=bar_w / 2, fill=(255, 255, 255, 255))
    x += bar_w + gap

img.save("assets/icon.png")
img.resize((256, 256), Image.LANCZOS).save(
    "assets/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icon written", img.size)
