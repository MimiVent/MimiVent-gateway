import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';

export function certificateFingerprint(certificatePath) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certificatePath));
  return crypto.createHash('sha256').update(certificate.raw).digest('hex');
}

export function createAppSetupUri({
  host,
  gatewayPort,
  certificatePin,
  mqttPort,
  mqttUsername,
  mqttPassword,
}) {
  const query = new URLSearchParams({
    host,
    gwPort: String(gatewayPort),
    pin: certificatePin,
    mqttPort: String(mqttPort),
    mqttUser: mqttUsername,
    mqttPass: mqttPassword,
  });
  return `mimivent://nas?${query.toString()}`;
}

export async function createSetupArtifacts(options) {
  const uri = createAppSetupUri(options);
  return {
    uri,
    qrDataUrl: await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'Q',
      margin: 2,
      width: 360,
    }),
    terminalQr: await QRCode.toString(uri, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'Q',
    }),
  };
}

function escapeScriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

export function renderSetupPage({ uri, qrDataUrl }) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const configJson = escapeScriptJson(uri);
  return {
    nonce,
    html: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MimiVent NAS 快速配置</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17202a;font:16px system-ui,-apple-system,"Segoe UI",sans-serif}.card{max-width:560px;margin:32px auto;padding:28px;background:#fff;border-radius:20px;box-shadow:0 8px 30px #17202a12;text-align:center}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#4a5560}.qr{width:min(100%,360px);height:auto;margin:12px auto;image-rendering:pixelated}.notice{padding:12px;border-radius:12px;background:#fff4d6;text-align:left;font-size:14px}.actions{display:flex;gap:10px;margin-top:16px}button{flex:1;padding:13px;border:0;border-radius:10px;background:#1769e0;color:white;font-size:16px;font-weight:600}button.secondary{background:#e9eef5;color:#17202a}.uri{margin-top:14px;text-align:left;font-size:12px;overflow-wrap:anywhere;color:#59636e}.status{min-height:22px;color:#1769a8}@media(max-width:600px){.card{margin:12px;padding:20px;border-radius:14px}}</style></head>
<body><main class="card"><h1>MimiVent NAS 快速配置</h1><p>打开 MimiVent App 的“设备网络与 NAS 控制”，点击“扫码或选择图片，快速配置 NAS”。</p>
<img class="qr" src="${qrDataUrl}" alt="MimiVent NAS 配置二维码">
<div class="notice">二维码包含家庭 NAS 的 MQTT 用户名和密码。请只在自己的家庭网络中使用，不要转发或发布到公开页面。</div>
<div class="actions"><button id="copy">复制配置</button><button id="select" class="secondary">显示连接串</button></div>
<div id="uri" class="uri" hidden></div><div id="status" class="status" role="status"></div></main>
<script nonce="${nonce}">const configUri=${configJson};const status=document.getElementById('status');document.getElementById('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(configUri);status.textContent='已复制，可在 App 中粘贴导入。'}catch{document.getElementById('uri').hidden=false;document.getElementById('uri').textContent=configUri;status.textContent='请长按下方连接串并复制。'}});document.getElementById('select').addEventListener('click',()=>{const box=document.getElementById('uri');box.hidden=!box.hidden;box.textContent=box.hidden?'':configUri;status.textContent=box.hidden?'':'连接串含 MQTT 凭据，请勿分享。'});</script></body></html>`,
  };
}

export async function printSetupArtifacts(options) {
  const artifacts = await createSetupArtifacts(options);
  console.info('MimiVent App 配置连接串（包含 MQTT 凭据，仅供家庭局域网使用）：');
  console.info(artifacts.uri);
  console.info('MimiVent App 配置二维码：');
  console.info(artifacts.terminalQr);
}
