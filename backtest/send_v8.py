
import json, subprocess, urllib.request, io, uuid, datetime
r = subprocess.run(['npx','convex','env','list','--deployment','gregarious-goat-621'],
                   capture_output=True, text=True, cwd='/tmp/smc-sys')
tok = [l.split('=',1)[1].strip() for l in r.stdout.splitlines() if l.startswith('TELEGRAM_BOT_TOKEN=')][0]

def send(sym, n, offset):
    trades = json.load(open(f'/tmp/smc-sys/backtest/{sym}-trades.json'))
    for g in range(0, n, 10):
        batch = trades[g:g+10]
        media, files = [], []
        for i, t in enumerate(batch):
            fn = f'/tmp/smc-sys/backtest/{sym}-v4-{g+i+1}.png'
            d = datetime.datetime.fromtimestamp(t['openTime']/1000, datetime.timezone(datetime.timedelta(hours=8)))
            res = {'tp':'止盈','stop':'止损'}.get(t['result'], str(t['result']))
            cap = f"#{offset+g+i+1} {sym} {t['direction'].upper()} [CRT扫荡+MSS] {d:%m-%d %H:%M} {res} {t['pnlUsd']:+.2f}U RR{t['rr']:.1f}"
            media.append({"type":"photo","media":f"attach://f{i}","caption":cap if i==0 else ""})
            files.append((f"f{i}", fn))
        boundary = uuid.uuid4().hex
        body = io.BytesIO()
        def part(name, value):
            body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
        part("chat_id", "7055553084")
        part("media", json.dumps(media, ensure_ascii=False))
        for name, fn in files:
            body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}.png\"\r\nContent-Type: image/png\r\n\r\n".encode())
            body.write(open(fn,'rb').read()); body.write(b"\r\n")
        body.write(f"--{boundary}--\r\n".encode())
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMediaGroup",
            data=body.getvalue(), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        resp = json.loads(urllib.request.urlopen(req, timeout=90).read())
        print(sym, g+1, "-", min(g+10, n), ":", "OK" if resp.get("ok") else str(resp)[:200])

send("BTC", 3, 0)
send("XAU", 8, 3)
