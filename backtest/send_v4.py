
import json, subprocess, urllib.request, io, uuid
r = subprocess.run(['npx','convex','env','list','--deployment','gregarious-goat-621'],
                   capture_output=True, text=True, cwd='/tmp/smc-sys')
tok = [l.split('=',1)[1].strip() for l in r.stdout.splitlines() if l.startswith('TELEGRAM_BOT_TOKEN=')][0]
trades = json.load(open('/tmp/smc-sys/backtest/BTC-trades.json'))
def fmt_res(t):
    return {'tp':'止盈','stop':'止损'}.get(t['result'], t['result']) + f" {t['pnlUsd']:+.2f}U"
media, files = [], []
for i, t in enumerate(trades):
    fn = f'/tmp/smc-sys/backtest/BTC-v4-{i+1}.png'
    media.append({"type":"photo","media":f"attach://f{i}","caption":f"#{i+1} BTC {t['direction'].upper()} [{t['trigger']}] {fmt_res(t)}" if i==0 else ""})
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
print("BTC 5张:", "OK" if resp.get("ok") else resp)
