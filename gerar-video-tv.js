const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

const FPS = 15;

// Duração de cada slide (segundos) × 2 ciclos
const SCHEDULE = [
  { slide: 1, secs: 10 },
  { slide: 2, secs: 12 },
  { slide: 3, secs: 25 },
  { slide: 1, secs: 10 },
  { slide: 2, secs: 12 },
  { slide: 3, secs: 25 },
];

const TOTAL_SECS = SCHEDULE.reduce((a, s) => a + s.secs, 0);
const TOTAL      = TOTAL_SECS * FPS;

const ARQUIVO_HTML = path.resolve(__dirname, 'tv-display.html');
const PASTA_FRAMES = path.resolve(__dirname, '_frames_tmp');
const SAIDA        = path.resolve(__dirname, 'tv-display.mp4');

async function main() {
  if (!fs.existsSync(PASTA_FRAMES)) fs.mkdirSync(PASTA_FRAMES);

  console.log('🚀 Abrindo navegador...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Bloqueia os setTimeout longos da página (ciclo automático de slides)
  await page.evaluateOnNewDocument(() => {
    const _orig = window.setTimeout;
    window.setTimeout = function(fn, delay, ...args) {
      if (delay >= 5000) return 0; // impede troca automática de slides
      return _orig.call(this, fn, delay, ...args);
    };
  });

  await page.goto(`file://${ARQUIVO_HTML}`, { waitUntil: 'networkidle0', timeout: 30000 });

  // Remove transição CSS dos slides e expõe função de troca instantânea
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '.slide { transition: none !important; }';
    document.head.appendChild(s);

    window._sw = function(n) {
      document.querySelectorAll('.slide').forEach((el, i) => {
        el.classList.toggle('active', i + 1 === n);
        el.style.transition = 'none';
      });
      document.querySelectorAll('.dot-ind').forEach((el, i) => {
        el.classList.toggle('active', i + 1 === n);
      });
    };

    window._sw(1);
  });

  // Aguarda primeiro render estabilizar
  await new Promise(r => setTimeout(r, 1500));

  console.log(`📸 Capturando ${TOTAL} frames (${TOTAL_SECS}s a ${FPS}fps)...\n`);

  let frameIndex = 0;

  for (const { slide, secs } of SCHEDULE) {
    const frames = secs * FPS;

    // Troca para o slide e aguarda repaint
    await page.evaluate((n) => window._sw(n), slide);
    await new Promise(r => setTimeout(r, 150));

    for (let f = 0; f < frames; f++) {
      const framePath = path.join(PASTA_FRAMES, `frame_${String(frameIndex).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath });
      frameIndex++;

      const pct = Math.round((frameIndex / TOTAL) * 100);
      process.stdout.write(`\r  ${pct}%  frame ${frameIndex}/${TOTAL}  [slide ${slide}]`);
    }
  }

  await browser.close();
  console.log('\n\n🎬 Compilando vídeo MP4...');

  execSync(
    `"${ffmpegPath}" -r ${FPS} -i "${PASTA_FRAMES}/frame_%05d.png" ` +
    `-c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p ` +
    `-vf "scale=1920:1080" -movflags +faststart -y "${SAIDA}"`,
    { stdio: 'inherit' }
  );

  fs.readdirSync(PASTA_FRAMES).forEach(f => fs.unlinkSync(path.join(PASTA_FRAMES, f)));
  fs.rmdirSync(PASTA_FRAMES);

  console.log(`\n✅ Vídeo salvo em: ${SAIDA}`);
  console.log('   Copie tv-display.mp4 para um pen drive e conecte na TV.');
  console.log(`   Duração total: ${TOTAL_SECS}s (2 ciclos completos)`);
}

main().catch(err => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});
