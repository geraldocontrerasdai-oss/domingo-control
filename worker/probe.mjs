// Prueba de viabilidad: abre la página pública de seguimiento de cada naviera/courier con un
// navegador real y escribe en el registro qué vio (carga, bloqueo, texto de la página).
import { chromium } from "playwright";

const SITES = {
  MSC: { url: "https://www.msc.com/en/track-a-shipment", form: true },
  ONE: { url: "https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking", form: true },
  EGLV: { url: "https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do", form: true },
  HLCU: { url: "https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html", form: true },
  MAEU: { url: (n) => `https://www.maersk.com/tracking/${n}` },
  CMDU: { url: "https://www.cma-cgm.com/ebusiness/tracking/search", form: true },
  COSU: { url: "https://elines.coscoshipping.com/ebusiness/cargoTracking", form: true },
  CROWLEY: { url: "https://www.crowley.com/logistics/track-trace/", form: true },
  FEDEX: { url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  DHL: { url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}` },
};

const jobs = (process.env.NUMBERS ?? "").split(",").map((p) => p.trim().split("=")).filter((p) => p.length === 2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });

for (const [code, num] of jobs) {
  const site = SITES[code.toUpperCase()];
  if (!site) { console.log(`== ${code}: código desconocido`); continue; }
  const page = await ctx.newPage();
  let verdict = "", text = "";
  try {
    const url = typeof site.url === "function" ? site.url(num) : site.url;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);
    if (site.form) {
      // Aceptar cookies si aparece el aviso, y buscar el primer campo de texto visible
      await page.locator("button:has-text('Accept'), button:has-text('Allow all'), button:has-text('Agree')").first().click({ timeout: 3000 }).catch(() => {});
      const box = page.locator("input[type=text]:visible, input[type=search]:visible, input:not([type]):visible").first();
      if (await box.count()) { await box.fill(num, { timeout: 8000 }).catch(() => {}); await box.press("Enter").catch(() => {}); await page.waitForTimeout(9000); }
      else verdict += "no encontré el campo del número · ";
    } else await page.waitForTimeout(8000);
    text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const blocked = /access denied|captcha|verify you are human|unusual traffic|forbidden|blocked|robot/i.test(text);
    verdict += `${blocked ? "BLOQUEADO/VERIFICACIÓN" : "cargó"} · HTTP ${res?.status()} · ${text.toUpperCase().includes(num.toUpperCase()) ? "el número aparece" : "el número NO aparece"}`;
  } catch (e) {
    verdict += `ERROR: ${e.message.split("\n")[0].slice(0, 160)}`;
  }
  console.log(`== ${code}: ${verdict}`);
  console.log(`   texto: ${text.slice(0, 500)}`);
  await page.close();
}
await browser.close();
