
import cairosvg, re
for sym in ("BTC","XAU"):
    svg = open(f"/tmp/smc-sys/backtest/{sym}-story4.svg").read()
    parts = re.findall(r"<svg.*?</svg>", svg, re.S)
    for i, p in enumerate(parts):
        cairosvg.svg2png(bytestring=p.encode(), write_to=f"/tmp/smc-sys/backtest/{sym}-v4-{i+1}.png", output_width=1100, output_height=1500)
    print(sym, len(parts))
