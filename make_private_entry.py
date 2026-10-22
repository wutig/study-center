"""Create the owner's local QR entry. It is always outside the published tree."""
from pathlib import Path
import argparse
import html
import json
import re
import sys

ROOT = Path(__file__).resolve().parent
PRIVATE = ROOT / '.private'
PUBLIC_URL = 'https://wutig.github.io/study-center/'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tablet', action='store_true', help='Create the Android tablet entry instead of the phone entry.')
    args = parser.parse_args()
    key = (PRIVATE / 'key.txt').read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', key):
        raise ValueError('Expected a private 256-bit access key.')
    sys.path.insert(0, str(ROOT.parent / '复习中心' / 'vendor' / 'qrcode'))
    from qrcodegen import QrCode
    private_url = PUBLIC_URL + ('?layout=tablet' if args.tablet else '') + '#key=' + key
    qr = QrCode.encode_text(private_url, QrCode.Ecc.MEDIUM)
    size = qr.get_size()
    cells = ' '.join(f'M{x+4},{y+4}h1v1h-1z' for y in range(size) for x in range(size) if qr.get_module(x, y))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size+8} {size+8}" '
           f'aria-label="公网复习中心私有入口二维码" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/>'
           f'<path d="{cells}" fill="black"/></svg>')
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>公网复习入口</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#f3eee5;color:#302e28;font:17px/1.7 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:780px;padding:32px 40px;margin:auto;border:1px solid #ddd3c4;border-radius:20px;background:#fffdf7}
h1{margin:0 0 8px;font-size:28px}.sub{color:#6f685b;margin:0}.qr{max-width:320px;margin:20px auto}.qr svg{display:block;width:100%}
li{margin:10px 0}a{color:#94352d}button{background:#94352d;color:#fff;border:0;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer}
textarea{width:100%;font:14px/1.6 monospace;resize:vertical;padding:10px;border:1px solid #cdbda7;border-radius:8px}details{margin-top:20px;border-top:1px solid #e0d7c9;padding-top:14px}summary{cursor:pointer}
@media(max-width:600px){body{padding:10px}main{padding:24px}}
</style><main><h1>用手机随时复习</h1><p class="sub">GitHub Pages 公网版 · 电脑关机也能打开</p>
<div class="qr">__QR__</div><ol>
<li>iPhone 打开 VPN，用相机扫描二维码，在 <strong>Safari</strong> 打开。</li>
<li>通过分享菜单<strong>添加到主屏幕</strong>。建议之后固定从这个图标复习。</li>
<li>主屏幕入口若要求解锁，粘贴下方的完整私有链接。开始写笔记前先选定这个入口。</li>
<li>手机笔记保存在当前浏览器。定期点<strong>备份记录</strong>，把 ZIP 存到“文件”。</li>
</ol><p><a href="__URL__" rel="noreferrer">在这台电脑打开公网复习中心 ↗</a></p>
<details><summary>完整私有链接与电脑旧笔记迁移</summary><p>这是你自己的题库解锁入口，请妥善保留。</p>
<textarea id="private-link" rows="3" readonly>__URL__</textarea><button onclick="document.getElementById('private-link').select();document.execCommand('copy');this.textContent='已复制链接'">复制完整链接</button>
<p>需要带上原电脑笔记：把旁边的 <a href="电脑笔记迁移.zip">电脑笔记迁移.zip</a> 发到手机，在网站点“恢复备份”导入。它仅在你的电脑上，不在公开仓库。</p>
<p>Safari 与主屏幕 App、不同设备不会自动同步；换入口前请先备份。勿使用无痕浏览保存长期笔记。</p></details></main></html>'''
    if args.tablet:
        page = (page.replace('用手机随时复习', 'vivo Pad5 平板复习')
                .replace('iPhone 打开 VPN', '平板打开 VPN')
                .replace('<strong>Safari</strong>', '<strong>Chrome 或 Edge</strong>')
                .replace('通过分享菜单<strong>添加到主屏幕</strong>', '在浏览器菜单选择<strong>添加到主屏幕或安装应用</strong>')
                .replace('手机笔记保存在当前浏览器', '平板笔记保存在当前浏览器')
                .replace('Safari 与主屏幕 App、不同设备不会自动同步', '不同浏览器与不同设备的记录不会自动同步')
                .replace('发到手机', '发到平板'))
    PRIVATE.mkdir(exist_ok=True)
    entry = PRIVATE / ('vivoPad5平板入口.html' if args.tablet else '手机公网入口.html')
    entry.write_text(page.replace('__QR__', svg).replace('__URL__', html.escape(private_url)), encoding='utf-8')
    (PRIVATE / ('平板复习中心.url' if args.tablet else '公网复习中心.url')).write_text('[InternetShortcut]\nURL=' + private_url + '\n', encoding='utf-8')
    print(json.dumps({'entry': str(entry), 'public_url': PUBLIC_URL}, ensure_ascii=True))


if __name__ == '__main__':
    main()
