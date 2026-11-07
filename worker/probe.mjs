// Prueba de viabilidad: abre cada página pública de seguimiento con un navegador real
// y dice si cargó, si pidió verificación (captcha) o si bloqueó la conexión.
import { chromium } from "playwright";
import fs from "fs";

const targets = [
  { name: "MSC", num: process.env.MSC, url: () => "https://www.msc.com/en/track-a-shipment" },
  { name: "Crowley", num: process.env.CROWLEY, url: () => "https://www.crowley.com/logistics/track-trace/" },
  { name: "FedEx", num: process.env.FEDEX, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { name: "DHL", num: process.env.DHL, url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}` },
].filter((t) => t.num);

fs.mkdirSync("out", { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });

for (const t of targets) {
  const page = await ctx.newPage();
  let verdict = "";
  try {
    const res = await page.goto(t.url(t.num), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    // MSC y Crowley piden el número en un formulario
    if (t.name === "MSC" || t.name === "Crowley") {
      const box = page.locator("input[type=text], input[type=search], input:not([type])").first();
      if (await box.count()) { await box.fill(t.num); await box.press("Enter"); await page.waitForTimeout(8000); }
    } else { await page.waitForTimeout(6000); }
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const blocked = /access denied|captcha|verify you are human|unusual traffic|forbidden|blocked/i.test(text);
    const found = text.toUpperCase().includes(String(t.num).toUpperCase());
    verdict = `${blocked ? "BLOQUEADO/VERIFICACIÓN" : "cargó"} · HTTP ${res?.status()} · ${found ? "el número aparece en la página" : "el número NO aparece"}`;
    fs.writeFileSync(`out/${t.name}.txt`, text.slice(0, 4000));
    await page.screenshot({ path: `out/${t.name}.png`, fullPage: false });
  } catch (e) {
    verdict = `ERROR: ${e.message.split("\n")[0]}`;
  }
  console.log(`== ${t.name}: ${verdict}`);
  await page.close();
}
await browser.close();
