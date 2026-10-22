# 逐张像素自检：右列文字重叠、底部时间轴、标题区、整体墨水分布
from PIL import Image
import itertools, sys

def check(path):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    px = img.load()
    def ink_rows(x0, x1, y0, y1, thr=190):
        out = []
        for y in range(y0, y1):
            found = False
            for x in range(x0, x1, 2):
                r, g, b = px[x, y]
                if r < thr and g < thr and b < thr:
                    found = True; break
            out.append(found)
        return out
    issues = []
    # 1) 标题区 y<60 必须有墨
    if not any(ink_rows(0, 900, 5, 55)):
        issues.append('标题缺失')
    # 2) 底部时间轴区必须有墨
    if not any(ink_rows(0, W, H-100, H-40)):
        issues.append('时间轴缺失')
    # 3) 右列文字块两两间距：块高>18 的相邻块间隔<2px 视为过贴
    rr = ink_rows(W-280, W, 55, H-110)
    segs = []
    y = 0
    for k, g in itertools.groupby(rr):
        n = len(list(g))
        if k: segs.append((y+55, n))
        y += n
    tight = 0
    for i in range(1, len(segs)):
        prev_end = segs[i-1][0] + segs[i-1][1]
        gap = segs[i][0] - prev_end
        if gap < 2 and segs[i][1] > 12: tight += 1
    if tight > 2: issues.append(f'右列过贴块 {tight}')
    # 4) 右侧文字越界（x 到达 W-2 边缘）
    edge = 0
    for y in range(55, H-110, 4):
        r, g, b = px[W-3, y]
        if r < 190 and g < 190 and b < 190: edge += 1
    if edge > 5: issues.append(f'右缘裁切 {edge}')
    return issues

bad = 0
for sym, n in (('BTC', 3), ('XAU', 4)):
    for i in range(1, n+1):
        p = f'/tmp/smc-sys/backtest/{sym}-v4-{i}.png'
        issues = check(p)
        if issues:
            bad += 1
            print(f'{sym} #{i}: {issues}')
print('有问题的图:', bad, '/', 7)
